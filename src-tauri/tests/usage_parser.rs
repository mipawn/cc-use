use cc_use_lib::proxy::usage_parser::{
    parse_usage_from_response, parse_usage_from_response_data, StreamUsageAccumulator,
};

#[test]
fn first_output_ignores_metadata_heartbeats_and_usage() {
    let mut acc = StreamUsageAccumulator::new();
    for event in [
        r#": keepalive"#,
        r#"data: {"type":"ping"}"#,
        r#"data: {"type":"message_start","message":{"usage":{"output_tokens":1}}}"#,
        r#"data: {"type":"content_block_start","content_block":{"type":"text","text":""}}"#,
        r#"data: {"choices":[{"delta":{"role":"assistant","content":""}}]}"#,
        r#"data: {"type":"response.created","response":{"status":"in_progress"}}"#,
        r#"data: {"type":"response.completed","response":{"usage":{"output_tokens":50}}}"#,
        r#"data: [DONE]"#,
    ] {
        acc.process_chunk(&format!("{event}\n\n"));
        assert!(!acc.has_output(), "metadata must not count: {event}");
    }
}

#[test]
fn first_output_recognizes_text_reasoning_and_tool_calls_across_protocols() {
    for event in [
        r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}"#,
        r#"{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"let me think"}}"#,
        r#"{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}"#,
        r#"{"type":"content_block_start","content_block":{"type":"tool_use","name":"read_file"}}"#,
        r#"{"choices":[{"delta":{"content":"hello"}}]}"#,
        r#"{"choices":[{"delta":{"reasoning_content":"thinking"}}]}"#,
        r#"{"choices":[{"delta":{"tool_calls":[{"function":{"name":"read_file"}}]}}]}"#,
        r#"{"type":"response.output_text.delta","delta":"hello"}"#,
        r#"{"type":"response.reasoning_summary_text.delta","delta":"thinking"}"#,
        r#"{"type":"response.function_call_arguments.delta","delta":"{"}"#,
        r#"{"type":"response.output_item.added","item":{"type":"function_call","name":"read_file"}}"#,
    ] {
        let mut acc = StreamUsageAccumulator::new();
        let line = format!("data: {event}\n\n");
        // Transport chunks may split JSON, including UTF-8 codepoints.
        for chunk in line.as_bytes().chunks(3) {
            acc.process_bytes(chunk);
        }
        assert!(acc.has_output(), "missing output: {event}");
    }
}

#[test]
fn parse_claude_response() {
    let body = r#"{"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":5},"model":"claude-sonnet-4"}"#;
    let (usage, model) = parse_usage_from_response(body);
    let usage = usage.unwrap();

    assert_eq!(usage.input_tokens, 100);
    assert_eq!(usage.output_tokens, 50);
    assert_eq!(usage.cache_read_tokens, 10);
    assert_eq!(usage.cache_creation_tokens, 5);
    assert_eq!(model.unwrap(), "claude-sonnet-4");
}

#[test]
fn parse_openai_response() {
    let body = r#"{"usage":{"prompt_tokens":200,"completion_tokens":100},"model":"gpt-4o"}"#;
    let (usage, model) = parse_usage_from_response(body);
    let usage = usage.unwrap();

    assert_eq!(usage.input_tokens, 200);
    assert_eq!(usage.output_tokens, 100);
    assert_eq!(model.unwrap(), "gpt-4o");
}

#[test]
fn parse_openai_prompt_token_details_cache() {
    let body = r#"{"usage":{"prompt_tokens":200,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":75}},"model":"gpt-4o"}"#;
    let (usage, _) = parse_usage_from_response(body);
    let usage = usage.unwrap();

    assert_eq!(usage.input_tokens, 125);
    assert_eq!(usage.output_tokens, 100);
    assert_eq!(usage.cache_read_tokens, 75);
}

#[test]
fn parse_deepseek_cache_hit_and_miss_tokens() {
    let body = r#"{"usage":{"prompt_tokens":200,"completion_tokens":100,"prompt_cache_hit_tokens":150,"prompt_cache_miss_tokens":50},"model":"deepseek-v4-pro"}"#;
    let (usage, model) = parse_usage_from_response(body);
    let usage = usage.unwrap();

    assert_eq!(usage.input_tokens, 50);
    assert_eq!(usage.output_tokens, 100);
    assert_eq!(usage.cache_read_tokens, 150);
    assert_eq!(model.unwrap(), "deepseek-v4-pro");
}

#[test]
fn parse_glm_usage_and_cached_tokens() {
    let body = r#"{"model":"glm-5.2","usage":{"prompt_tokens":200,"completion_tokens":125,"prompt_tokens_details":{"cached_tokens":75},"total_tokens":325}}"#;
    let (usage, model) = parse_usage_from_response(body);
    let usage = usage.unwrap();

    assert_eq!(usage.input_tokens, 125);
    assert_eq!(usage.output_tokens, 125);
    assert_eq!(usage.cache_read_tokens, 75);
    assert_eq!(model.unwrap(), "glm-5.2");
}

#[test]
fn parse_cache_only_usage_is_billable_usage() {
    let chunk = "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-4\",\"usage\":{\"input_tokens\":0,\"cache_read_input_tokens\":42}}}\n\n";
    let mut accumulator = StreamUsageAccumulator::new();
    accumulator.process_chunk(chunk);
    accumulator.flush();
    let usage = accumulator.get_usage().unwrap();

    assert_eq!(usage.input_tokens, 0);
    assert_eq!(usage.output_tokens, 0);
    assert_eq!(usage.cache_read_tokens, 42);
}

#[test]
fn parse_openai_responses_nested_usage() {
    let body = r#"{"type":"response.completed","response":{"id":"resp-test","model":"gpt-5.5","usage":{"input_tokens":200,"output_tokens":100,"input_tokens_details":{"cached_tokens":25}}}}"#;
    let (usage, model) = parse_usage_from_response(body);
    let usage = usage.unwrap();

    assert_eq!(usage.input_tokens, 175);
    assert_eq!(usage.output_tokens, 100);
    assert_eq!(usage.cache_read_tokens, 25);
    assert_eq!(model.unwrap(), "gpt-5.5");
}

#[test]
fn parse_no_usage() {
    let body = r#"{"error":"bad request"}"#;
    let (usage, _) = parse_usage_from_response(body);
    assert!(usage.is_none());
}

#[test]
fn parse_streaming_sse() {
    let chunk = "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-4\",\"usage\":{\"input_tokens\":500,\"cache_read_input_tokens\":20}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":300}}\n\n";
    let mut accumulator = StreamUsageAccumulator::new();
    accumulator.process_chunk(chunk);
    accumulator.flush();
    let usage = accumulator.get_usage().unwrap();

    assert_eq!(usage.input_tokens, 500);
    assert_eq!(usage.output_tokens, 300);
    assert_eq!(usage.cache_read_tokens, 20);
    assert_eq!(accumulator.model.unwrap(), "claude-sonnet-4");
}

#[test]
fn parse_openai_responses_streaming_sse() {
    let chunk = "data: {\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-5.5\",\"usage\":{\"input_tokens\":120,\"output_tokens\":40,\"input_tokens_details\":{\"cached_tokens\":12}}}}\n\n";

    let (usage, model, is_streaming) = parse_usage_from_response_data(chunk, "text/event-stream");
    let usage = usage.unwrap();

    assert!(is_streaming);
    assert_eq!(usage.input_tokens, 108);
    assert_eq!(usage.output_tokens, 40);
    assert_eq!(usage.cache_read_tokens, 12);
    assert_eq!(model.unwrap(), "gpt-5.5");
}

#[test]
fn parse_glm_streaming_sse_with_cached_tokens() {
    let chunk = "data: {\"model\":\"glm-5.2\",\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":50,\"prompt_tokens_details\":{\"cached_tokens\":20}}}\n\n";

    let (usage, model, is_streaming) = parse_usage_from_response_data(chunk, "text/event-stream");
    let usage = usage.unwrap();

    assert!(is_streaming);
    assert_eq!(usage.input_tokens, 100);
    assert_eq!(usage.output_tokens, 50);
    assert_eq!(usage.cache_read_tokens, 20);
    assert_eq!(model.unwrap(), "glm-5.2");
}

#[test]
fn parses_sse_data_without_separator_space_and_case_insensitive_content_type() {
    let chunk = "data:{\"type\":\"message_delta\",\"usage\":{\"output_tokens\":33}}\n\n";

    let (usage, _, is_streaming) =
        parse_usage_from_response_data(chunk, "Text/Event-Stream; Charset=UTF-8");

    assert!(is_streaming);
    assert_eq!(usage.unwrap().output_tokens, 33);
}

#[test]
fn cross_chunk_splitting() {
    let chunk1 = "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-4\",\"usage\":{\"input_to";
    let chunk2 = "kens\":500,\"cache_read_input_tokens\":20}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":300}}\n\n";

    let mut accumulator = StreamUsageAccumulator::new();
    accumulator.process_chunk(chunk1);
    assert_eq!(accumulator.input_tokens, 0);

    accumulator.process_chunk(chunk2);
    accumulator.flush();
    let usage = accumulator.get_usage().unwrap();
    assert_eq!(usage.input_tokens, 500);
    assert_eq!(usage.output_tokens, 300);
    assert_eq!(usage.cache_read_tokens, 20);
    assert_eq!(accumulator.model.unwrap(), "claude-sonnet-4");
}

#[test]
fn flush_incomplete_final_line() {
    let chunk = "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-4\",\"usage\":{\"input_tokens\":100}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":50}}";

    let mut accumulator = StreamUsageAccumulator::new();
    accumulator.process_chunk(chunk);
    assert_eq!(accumulator.output_tokens, 0);

    accumulator.flush();
    let usage = accumulator.get_usage().unwrap();
    assert_eq!(usage.input_tokens, 100);
    assert_eq!(usage.output_tokens, 50);
}

#[test]
fn oversized_sse_line_is_discarded_without_losing_following_usage() {
    let mut accumulator = StreamUsageAccumulator::new();
    accumulator.process_bytes(b"data: ");
    accumulator.process_bytes(&vec![b'a'; 1024 * 1024 + 1]);
    accumulator.process_bytes(
        b"\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":77}}\n\n",
    );
    accumulator.flush();

    assert_eq!(accumulator.get_usage().unwrap().output_tokens, 77);
}

#[test]
fn stream_completion_markers_are_recognized() {
    let cases: [(&str, bool); 5] = [
        ("data: {\"type\":\"message_stop\"}\n\n", true),
        ("data: [DONE]\n\n", true),
        (
            "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
            true,
        ),
        (
            "data: {\"choices\":[{\"finish_reason\":\"stop\"}]}\n\n",
            true,
        ),
        (
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1}}}\n\n",
            false,
        ),
    ];
    for (chunk, expected) in cases {
        let mut accumulator = StreamUsageAccumulator::new();
        accumulator.process_chunk(chunk);
        assert_eq!(accumulator.completed(), expected, "chunk: {chunk}");
    }
}

#[test]
fn usage_before_a_truncated_stream_is_not_a_completed_stream() {
    let mut accumulator = StreamUsageAccumulator::new();
    accumulator.process_chunk(
        "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10}}}\n\n",
    );
    accumulator
        .process_chunk("data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":5}}\n\n");
    accumulator.flush();

    assert_eq!(accumulator.get_usage().unwrap().output_tokens, 5);
    assert!(!accumulator.completed());
}

#[test]
fn flush_recognizes_a_completion_marker_without_a_trailing_newline() {
    let mut accumulator = StreamUsageAccumulator::new();
    accumulator.process_chunk("data: {\"type\":\"message_stop\"}");
    assert!(!accumulator.completed());

    accumulator.flush();
    assert!(accumulator.completed());
}
