//! Bounded protobuf wire reader for Antigravity conversation telemetry.
//!
//! Antigravity stores its generation telemetry as protobuf blobs inside each
//! conversation database: `gen_metadata.data` holds the token counts, durations
//! and model of one generation, and `steps.metadata` holds a
//! `google.protobuf.Timestamp`. Only a handful of fields are ever needed, so the
//! wire format is decoded directly instead of pulling in a protobuf runtime:
//!
//! - nothing is allocated for a blob beyond the strings actually extracted,
//!   lengths are validated against the remaining bytes before slicing, and
//! - unknown fields are skipped by their declared wire type, so a schema change
//!   upstream degrades to missing values instead of an error.
//!
//! The field numbers below were verified against the local Antigravity
//! databases (14 conversations, 701 generations): `output_tokens` always equals
//! `thinking_tokens + response_tokens`, and every generation carries both
//! durations, its model name, and its response id.

use chrono::{DateTime, SecondsFormat, Utc};

/// `gen_metadata.data` field numbers.
const WRAPPER: u32 = 1;
const USAGE: u32 = 4;
const METADATA: u32 = 20;
/// Wrapper fields holding the two durations and the model name.
const TTFT: u32 = 11;
const GENERATION: u32 = 12;
const MODEL_FAMILY: u32 = 19;
const MODEL_DISPLAY: u32 = 21;

/// `gen_metadata.data.f1.f4` field numbers.
const INPUT_TOKENS: u32 = 2;
const OUTPUT_TOKENS: u32 = 3;
const CACHE_CREATION_TOKENS: u32 = 4;
const CACHE_READ_TOKENS: u32 = 5;
const BOT_ID: u32 = 7;
const THINKING_TOKENS: u32 = 9;
const RESPONSE_TOKENS: u32 = 10;
const RESPONSE_ID: u32 = 11;

/// `google.protobuf.Duration` / `google.protobuf.Timestamp` field numbers.
const SECONDS: u32 = 1;
const NANOS: u32 = 2;

/// Repeated metadata map entry (`{ f1: key, f2: value }`) field numbers.
const MAP_KEY: u32 = 1;
const MAP_VALUE: u32 = 2;

/// `steps.metadata` field holding the step's `google.protobuf.Timestamp`.
const STEP_TIMESTAMP: u32 = 1;

/// The map keys inside `f1.f20` that are worth keeping.
const KEY_LAST_STEP_INDEX: &str = "last_step_index";
const KEY_REQUEST_ID: &str = "request_id";

/// Telemetry decoded from one `gen_metadata.data` blob.
///
/// Token counters default to `0` when their field is absent, matching the
/// "absent means zero" convention of the usage block. The optional fields stay
/// `None` when the field is missing so the index can distinguish "not reported"
/// from "reported as zero".
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GenerationTelemetry {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub thinking_tokens: Option<i64>,
    pub response_tokens: Option<i64>,
    pub bot_id: Option<String>,
    pub response_id: Option<String>,
    pub ttft_ms: Option<i64>,
    pub generation_ms: Option<i64>,
    pub model: Option<String>,
    pub last_step_index: Option<i64>,
    pub request_id: Option<String>,
}

/// Decodes one `gen_metadata.data` blob.
///
/// Returns `None` when the blob is not a generation record — no `f1` wrapper, or
/// no token/identity block inside it — so the reader never indexes a row it
/// cannot describe.
pub fn decode_gen_metadata(data: &[u8]) -> Option<GenerationTelemetry> {
    let wrapper = bytes_field(data, WRAPPER)?;
    let usage = bytes_field(wrapper, USAGE)?;

    Some(GenerationTelemetry {
        input_tokens: varint_i64(usage, INPUT_TOKENS),
        output_tokens: varint_i64(usage, OUTPUT_TOKENS),
        cache_creation_tokens: varint_i64(usage, CACHE_CREATION_TOKENS),
        cache_read_tokens: varint_i64(usage, CACHE_READ_TOKENS),
        thinking_tokens: optional_varint_i64(usage, THINKING_TOKENS),
        response_tokens: optional_varint_i64(usage, RESPONSE_TOKENS),
        bot_id: string_field(usage, BOT_ID),
        response_id: string_field(usage, RESPONSE_ID),
        ttft_ms: duration_ms(wrapper, TTFT),
        generation_ms: duration_ms(wrapper, GENERATION),
        model: string_field(wrapper, MODEL_DISPLAY).or_else(|| string_field(wrapper, MODEL_FAMILY)),
        last_step_index: metadata_value(wrapper, KEY_LAST_STEP_INDEX)
            .and_then(|value| value.parse().ok()),
        request_id: metadata_value(wrapper, KEY_REQUEST_ID),
    })
}

/// Decodes the `google.protobuf.Timestamp` inside one `steps.metadata` blob.
///
/// The result is fixed-width RFC 3339 UTC
/// (`YYYY-MM-DDTHH:MM:SS.mmm+00:00`): the retention sweep deletes by string
/// comparison, so fractional-second width must never vary.
pub fn decode_step_timestamp(metadata: &[u8]) -> Option<String> {
    let timestamp = bytes_field(metadata, STEP_TIMESTAMP)?;
    let seconds = i64::try_from(varint_field(timestamp, SECONDS)?).ok()?;
    let nanos = u32::try_from(varint_field(timestamp, NANOS).unwrap_or(0)).ok()?;
    rfc3339_utc(seconds, nanos)
}

/// `RFC 3339` with exactly three fractional digits and a `+00:00` offset.
fn rfc3339_utc(seconds: i64, nanos: u32) -> Option<String> {
    let timestamp = DateTime::<Utc>::from_timestamp(seconds, nanos)?;
    Some(timestamp.to_rfc3339_opts(SecondsFormat::Millis, false))
}

/// One field of a protobuf message.
enum Value<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

/// A cursor over one encoded message.
///
/// Fixed-width fields (wire types 1 and 5) are skipped transparently: no known
/// field uses them. Groups and invalid wire types stop the iteration, which lets
/// callers keep everything decoded up to the damage.
struct Reader<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    fn next(&mut self) -> Option<(u32, Value<'a>)> {
        loop {
            let key = self.read_varint()?;
            let number = u32::try_from(key >> 3).ok()?;
            if number == 0 {
                return None;
            }
            match key & 0b111 {
                0 => return Some((number, Value::Varint(self.read_varint()?))),
                1 => self.skip(8)?,
                2 => {
                    let length = usize::try_from(self.read_varint()?).ok()?;
                    let end = self.position.checked_add(length)?;
                    let payload = self.data.get(self.position..end)?;
                    self.position = end;
                    return Some((number, Value::Bytes(payload)));
                }
                5 => self.skip(4)?,
                _ => return None,
            }
        }
    }

    fn read_varint(&mut self) -> Option<u64> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = *self.data.get(self.position)?;
            self.position += 1;
            value |= u64::from(byte & 0x7F) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        // Protobuf varints are at most 10 bytes long.
        None
    }

    fn skip(&mut self, length: usize) -> Option<()> {
        self.position = self.position.checked_add(length)?;
        (self.position <= self.data.len()).then_some(())
    }
}

/// First varint field with this number.
fn varint_field(data: &[u8], number: u32) -> Option<u64> {
    let mut reader = Reader::new(data);
    while let Some((found, value)) = reader.next() {
        if found != number {
            continue;
        }
        if let Value::Varint(value) = value {
            return Some(value);
        }
    }
    None
}

/// First length-delimited field with this number.
fn bytes_field(data: &[u8], number: u32) -> Option<&[u8]> {
    let mut reader = Reader::new(data);
    while let Some((found, value)) = reader.next() {
        if found != number {
            continue;
        }
        if let Value::Bytes(payload) = value {
            return Some(payload);
        }
    }
    None
}

/// First non-empty UTF-8 string field with this number.
fn string_field(data: &[u8], number: u32) -> Option<String> {
    let bytes = bytes_field(data, number)?;
    let text = std::str::from_utf8(bytes).ok()?;
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

/// A varint counter that is absent from older blobs: absent reads as `0`.
fn varint_i64(data: &[u8], number: u32) -> i64 {
    i64::try_from(varint_field(data, number).unwrap_or(0)).unwrap_or(0)
}

/// A varint counter whose absence must stay distinguishable from `0`.
fn optional_varint_i64(data: &[u8], number: u32) -> Option<i64> {
    i64::try_from(varint_field(data, number)?).ok()
}

/// `google.protobuf.Duration` → milliseconds, truncating sub-millisecond nanos.
fn duration_ms(data: &[u8], number: u32) -> Option<i64> {
    let duration = bytes_field(data, number)?;
    let seconds = i64::try_from(varint_field(duration, SECONDS).unwrap_or(0)).ok()?;
    let nanos = i64::try_from(varint_field(duration, NANOS).unwrap_or(0)).ok()?;
    seconds.checked_mul(1_000)?.checked_add(nanos / 1_000_000)
}

/// Looks one key up in the repeated `{ f1: key, f2: value }` metadata map.
fn metadata_value(wrapper: &[u8], key: &str) -> Option<String> {
    let mut reader = Reader::new(wrapper);
    while let Some((number, value)) = reader.next() {
        if number != METADATA {
            continue;
        }
        let Value::Bytes(entry) = value else {
            continue;
        };
        if string_field(entry, MAP_KEY).as_deref() != Some(key) {
            continue;
        }
        if let Some(value) = string_field(entry, MAP_VALUE) {
            return Some(value);
        }
    }
    None
}

#[cfg(test)]
pub(crate) mod test_bytes {
    //! Minimal protobuf *writer* shared by the fixture tests of this module and
    //! of `antigravity_sync`: fixtures are encoded with the same wire format
    //! Antigravity writes, so the reader is exercised against genuine encoding
    //! rather than hand-picked bytes.

    use super::*;

    /// Minimal protobuf writer: `TestMessage` mirrors the real blob shapes, so
    /// the reader is always tested against genuine wire format rather than a
    /// hand-picked byte array.
    pub(crate) struct TestMessage(Vec<u8>);

    impl TestMessage {
        pub(crate) fn new() -> Self {
            Self(Vec::new())
        }

        pub(crate) fn varint(mut self, number: u32, value: u64) -> Self {
            self.0.extend(tag(number, 0));
            self.0.extend(varint_bytes(value));
            self
        }

        pub(crate) fn string(self, number: u32, value: &str) -> Self {
            self.bytes(number, value.as_bytes())
        }

        pub(crate) fn bytes(mut self, number: u32, payload: &[u8]) -> Self {
            self.0.extend(tag(number, 2));
            self.0.extend(varint_bytes(payload.len() as u64));
            self.0.extend_from_slice(payload);
            self
        }

        /// A field with an unsupported-by-`next` wire type: fixed32 or fixed64.
        pub(crate) fn fixed32(mut self, number: u32, value: u32) -> Self {
            self.0.extend(tag(number, 5));
            self.0.extend_from_slice(&value.to_le_bytes());
            self
        }

        pub(crate) fn fixed64(mut self, number: u32, value: u64) -> Self {
            self.0.extend(tag(number, 1));
            self.0.extend_from_slice(&value.to_le_bytes());
            self
        }

        pub(crate) fn finish(self) -> Vec<u8> {
            self.0
        }
    }

    /// `Duration { seconds, nanos }`.
    pub(crate) fn duration(seconds: u64, nanos: u32) -> Vec<u8> {
        let mut message = TestMessage::new();
        if seconds != 0 {
            message = message.varint(SECONDS, seconds);
        }
        if nanos != 0 {
            message = message.varint(NANOS, u64::from(nanos));
        }
        message.finish()
    }

    /// `Timestamp { seconds, nanos }`.
    pub(crate) fn timestamp(seconds: u64, nanos: u32) -> Vec<u8> {
        duration(seconds, nanos)
    }

    /// The usage/identity block (`gen_metadata.data.f1.f4`) with every field set.
    pub(crate) fn usage_block(tokens: [u64; 6], bot_id: &str, response_id: &str) -> Vec<u8> {
        let [input, output, cache_creation, cache_read, thinking, response] = tokens;
        TestMessage::new()
            .varint(INPUT_TOKENS, input)
            .varint(OUTPUT_TOKENS, output)
            .varint(CACHE_CREATION_TOKENS, cache_creation)
            .varint(CACHE_READ_TOKENS, cache_read)
            .varint(THINKING_TOKENS, thinking)
            .varint(RESPONSE_TOKENS, response)
            .string(BOT_ID, bot_id)
            .string(RESPONSE_ID, response_id)
            .finish()
    }

    /// One metadata-map entry (`{ f1: key, f2: value }`).
    pub(crate) fn metadata_entry(key: &str, value: &str) -> Vec<u8> {
        TestMessage::new()
            .string(MAP_KEY, key)
            .string(MAP_VALUE, value)
            .finish()
    }

    /// Wraps a usage block in the `f1` generation wrapper.
    pub(crate) fn generation(wrapper_fields: TestMessage, usage: &[u8]) -> Vec<u8> {
        TestMessage::new()
            .bytes(WRAPPER, &wrapper_fields.bytes(USAGE, usage).finish())
            .finish()
    }

    /// Wraps a `Timestamp` the way `steps.metadata` stores it.
    pub(crate) fn step_metadata(seconds: u64, nanos: u32) -> Vec<u8> {
        TestMessage::new()
            .bytes(STEP_TIMESTAMP, &timestamp(seconds, nanos))
            .finish()
    }

    /// One `gen_metadata.data` row fixture. Every `Option` that is `None` is
    /// simply absent from the encoded message.
    pub(crate) struct Generation {
        pub(crate) tokens: [u64; 6],
        pub(crate) bot_id: Option<&'static str>,
        pub(crate) response_id: Option<&'static str>,
        pub(crate) request_id: Option<&'static str>,
        pub(crate) last_step_index: Option<i64>,
        pub(crate) ttft_ms: Option<u64>,
        pub(crate) generation_ms: Option<u64>,
        pub(crate) model: Option<&'static str>,
    }

    impl Generation {
        /// 100 input / 40 output tokens (30 thinking + 10 response), 1.5 s TTFT,
        /// 2.25 s generation, a display model name and step index 1.
        pub(crate) fn typical() -> Self {
            Self {
                tokens: [100, 40, 0, 5, 30, 10],
                bot_id: Some("bot-1"),
                response_id: Some("resp-1"),
                request_id: Some("req-1"),
                last_step_index: Some(1),
                ttft_ms: Some(1_500),
                generation_ms: Some(2_250),
                model: Some("Gemini 4 Neon (High)"),
            }
        }

        pub(crate) fn encode(&self) -> Vec<u8> {
            let [input, output, cache_creation, cache_read, thinking, response] = self.tokens;
            let mut usage = TestMessage::new()
                .varint(INPUT_TOKENS, input)
                .varint(OUTPUT_TOKENS, output)
                .varint(CACHE_CREATION_TOKENS, cache_creation)
                .varint(CACHE_READ_TOKENS, cache_read)
                .varint(THINKING_TOKENS, thinking)
                .varint(RESPONSE_TOKENS, response);
            if let Some(bot_id) = self.bot_id {
                usage = usage.string(BOT_ID, bot_id);
            }
            if let Some(response_id) = self.response_id {
                usage = usage.string(RESPONSE_ID, response_id);
            }

            let mut wrapper = TestMessage::new();
            if let Some(ttft_ms) = self.ttft_ms {
                wrapper = wrapper.bytes(TTFT, &millis(ttft_ms));
            }
            if let Some(generation_ms) = self.generation_ms {
                wrapper = wrapper.bytes(GENERATION, &millis(generation_ms));
            }
            if let Some(model) = self.model {
                wrapper = wrapper.string(MODEL_DISPLAY, model);
            }
            if let Some(last_step_index) = self.last_step_index {
                wrapper = wrapper.bytes(
                    METADATA,
                    &metadata_entry(KEY_LAST_STEP_INDEX, &last_step_index.to_string()),
                );
            }
            if let Some(request_id) = self.request_id {
                wrapper = wrapper.bytes(METADATA, &metadata_entry(KEY_REQUEST_ID, request_id));
            }
            generation(wrapper, &usage.finish())
        }
    }

    /// `Duration` for a whole number of milliseconds.
    fn millis(milliseconds: u64) -> Vec<u8> {
        let nanos = u32::try_from((milliseconds % 1_000) * 1_000_000).unwrap_or(0);
        duration(milliseconds / 1_000, nanos)
    }

    fn tag(number: u32, wire_type: u32) -> Vec<u8> {
        varint_bytes(u64::from(number) << 3 | u64::from(wire_type))
    }

    fn varint_bytes(mut value: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let byte = (value & 0x7F) as u8;
            value >>= 7;
            if value == 0 {
                bytes.push(byte);
                return bytes;
            }
            bytes.push(byte | 0x80);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_bytes::*;
    use super::*;

    fn typical_generation() -> Vec<u8> {
        let usage = usage_block([14_657, 208, 0, 14_658, 154, 54], "bot-1", "resp-1");
        let wrapper = TestMessage::new()
            .bytes(TTFT, &duration(4, 956_556_750))
            .bytes(GENERATION, &duration(0, 982_440_625))
            .string(MODEL_FAMILY, "gemini-4-neon")
            .string(MODEL_DISPLAY, "Gemini 4 Neon (High)")
            .bytes(METADATA, &metadata_entry(KEY_LAST_STEP_INDEX, "0"))
            .bytes(METADATA, &metadata_entry(KEY_REQUEST_ID, "req-1"));
        generation(wrapper, &usage)
    }

    #[test]
    fn decodes_a_typical_generation_blob() {
        let telemetry = decode_gen_metadata(&typical_generation()).unwrap();
        assert_eq!(
            telemetry,
            GenerationTelemetry {
                input_tokens: 14_657,
                output_tokens: 208,
                cache_creation_tokens: 0,
                cache_read_tokens: 14_658,
                thinking_tokens: Some(154),
                response_tokens: Some(54),
                bot_id: Some("bot-1".to_string()),
                response_id: Some("resp-1".to_string()),
                ttft_ms: Some(4_956),
                generation_ms: Some(982),
                model: Some("Gemini 4 Neon (High)".to_string()),
                last_step_index: Some(0),
                request_id: Some("req-1".to_string()),
            }
        );
    }

    #[test]
    fn thinking_and_response_tokens_stay_separate_from_the_output_total() {
        let usage = usage_block([1, 300, 0, 0, 250, 50], "bot-1", "resp-1");
        let telemetry = decode_gen_metadata(&generation(TestMessage::new(), &usage)).unwrap();
        assert_eq!(telemetry.output_tokens, 300);
        assert_eq!(telemetry.thinking_tokens, Some(250));
        assert_eq!(telemetry.response_tokens, Some(50));
    }

    #[test]
    fn absent_counters_read_as_zero_but_absent_optionals_stay_none() {
        let usage = TestMessage::new().varint(INPUT_TOKENS, 10).finish();
        let telemetry = decode_gen_metadata(&generation(TestMessage::new(), &usage)).unwrap();
        assert_eq!(telemetry.input_tokens, 10);
        assert_eq!(telemetry.output_tokens, 0);
        assert_eq!(telemetry.cache_read_tokens, 0);
        assert_eq!(telemetry.cache_creation_tokens, 0);
        assert_eq!(telemetry.thinking_tokens, None);
        assert_eq!(telemetry.response_tokens, None);
        assert_eq!(telemetry.bot_id, None);
        assert_eq!(telemetry.response_id, None);
        assert_eq!(telemetry.ttft_ms, None);
        assert_eq!(telemetry.generation_ms, None);
        assert_eq!(telemetry.last_step_index, None);
    }

    #[test]
    fn model_falls_back_to_the_family_field() {
        let usage = usage_block([1, 2, 0, 0, 1, 1], "bot-1", "resp-1");
        let family_only = TestMessage::new().string(MODEL_FAMILY, "gemini-4-neon");
        let telemetry = decode_gen_metadata(&generation(family_only, &usage)).unwrap();
        assert_eq!(telemetry.model, Some("gemini-4-neon".to_string()));

        // The display name wins whenever it is present.
        let both = TestMessage::new()
            .string(MODEL_FAMILY, "gemini-4-neon")
            .string(MODEL_DISPLAY, "Gemini 4 Neon (High)");
        let telemetry = decode_gen_metadata(&generation(both, &usage)).unwrap();
        assert_eq!(telemetry.model, Some("Gemini 4 Neon (High)".to_string()));
    }

    #[test]
    fn unknown_fields_are_skipped_including_fixed_width_ones() {
        let usage = usage_block([7, 9, 0, 0, 4, 5], "bot-1", "resp-1");
        let wrapper = TestMessage::new()
            .fixed32(3, 42)
            .fixed64(5, 42)
            .varint(7, 42)
            .string(9, "unrelated")
            .bytes(TTFT, &duration(1, 500_000_000))
            .bytes(GENERATION, &duration(2, 0))
            .string(MODEL_DISPLAY, "Gemini 4 Neon (High)")
            .bytes(METADATA, &metadata_entry("cascade_id", "conv-1"))
            .bytes(METADATA, &metadata_entry(KEY_LAST_STEP_INDEX, "12"));
        let telemetry = decode_gen_metadata(&generation(wrapper, &usage)).unwrap();
        assert_eq!(telemetry.input_tokens, 7);
        assert_eq!(telemetry.ttft_ms, Some(1_500));
        assert_eq!(telemetry.generation_ms, Some(2_000));
        assert_eq!(telemetry.last_step_index, Some(12));
        // The unrelated map key is not mistaken for a known one.
        assert_eq!(telemetry.request_id, None);
    }

    #[test]
    fn a_blob_without_a_usage_block_is_not_a_generation() {
        let wrapper = TestMessage::new()
            .string(MODEL_DISPLAY, "Gemini 4 Neon (High)")
            .finish();
        let blob = TestMessage::new().bytes(WRAPPER, &wrapper).finish();
        assert_eq!(decode_gen_metadata(&blob), None);
    }

    #[test]
    fn malformed_input_decodes_to_none_without_panicking() {
        assert_eq!(decode_gen_metadata(&[]), None);
        assert_eq!(decode_gen_metadata(&[0xFF, 0xFF, 0xFF]), None);
        // A declared length beyond the available bytes must not slice.
        let blob = typical_generation();
        assert_eq!(decode_gen_metadata(&blob[..blob.len() / 2]), None);
        // Truncated varint (missing continuation terminator).
        assert_eq!(decode_gen_metadata(&[0x08, 0xFF]), None);
        // 11-byte varint is invalid protobuf.
        assert_eq!(
            decode_gen_metadata(&[
                0x08, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x01
            ]),
            None
        );
        // An unknown group wire type stops the reader instead of looping.
        assert_eq!(decode_gen_metadata(&[0x0B, 0x0C]), None);
    }

    #[test]
    fn duration_truncates_sub_millisecond_nanos() {
        let wrapper = TestMessage::new()
            .bytes(TTFT, &duration(4, 956_556_750))
            .bytes(GENERATION, &duration(0, 982_440_625));
        let blob = generation(wrapper, &usage_block([0, 0, 0, 0, 0, 0], "b", "r"));
        let telemetry = decode_gen_metadata(&blob).unwrap();
        assert_eq!(telemetry.ttft_ms, Some(4_956));
        assert_eq!(telemetry.generation_ms, Some(982));
        // A duration with only nanos, and one with only seconds.
        let wrapper = TestMessage::new()
            .bytes(TTFT, &duration(0, 1_000_000))
            .bytes(GENERATION, &duration(3, 0));
        let telemetry = decode_gen_metadata(&generation(
            wrapper,
            &usage_block([0, 0, 0, 0, 0, 0], "b", "r"),
        ))
        .unwrap();
        assert_eq!(telemetry.ttft_ms, Some(1));
        assert_eq!(telemetry.generation_ms, Some(3_000));
    }

    #[test]
    fn step_timestamp_is_fixed_width_utc() {
        let metadata = TestMessage::new()
            .bytes(STEP_TIMESTAMP, &timestamp(1_795_334_620, 845_717_000))
            .finish();
        assert_eq!(
            decode_step_timestamp(&metadata).as_deref(),
            Some("2026-11-22T08:03:40.845+00:00")
        );

        // Missing nanos still produces three fractional digits.
        let metadata = TestMessage::new()
            .bytes(STEP_TIMESTAMP, &timestamp(1_795_334_620, 0))
            .finish();
        assert_eq!(
            decode_step_timestamp(&metadata).as_deref(),
            Some("2026-11-22T08:03:40.000+00:00")
        );
    }

    #[test]
    fn step_timestamp_survives_missing_or_broken_timestamps() {
        assert_eq!(decode_step_timestamp(&[]), None);
        assert_eq!(decode_step_timestamp(&[0xFF]), None);
        // No timestamp field at all.
        let metadata = TestMessage::new().varint(3, 4).finish();
        assert_eq!(decode_step_timestamp(&metadata), None);
        // Out-of-range seconds cannot be formatted.
        let metadata = TestMessage::new()
            .bytes(STEP_TIMESTAMP, &timestamp(u64::MAX, 0))
            .finish();
        assert_eq!(decode_step_timestamp(&metadata), None);
        // Nanos above one second are rejected by chrono rather than normalized.
        let metadata = TestMessage::new()
            .bytes(STEP_TIMESTAMP, &timestamp(1, 2_000_000_000))
            .finish();
        assert_eq!(decode_step_timestamp(&metadata), None);
    }
}
