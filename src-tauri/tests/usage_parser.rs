use cc_use_lib::proxy::usage_parser::{
    parse_usage_from_response, parse_usage_from_response_data, StreamUsageAccumulator,
};

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
fn parse_openai_responses_nested_usage() {
    let body = r#"{"type":"response.completed","response":{"id":"resp-test","model":"gpt-5.5","usage":{"input_tokens":200,"output_tokens":100,"input_tokens_details":{"cached_tokens":25}}}}"#;
    let (usage, model) = parse_usage_from_response(body);
    let usage = usage.unwrap();

    assert_eq!(usage.input_tokens, 200);
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
    assert_eq!(usage.input_tokens, 120);
    assert_eq!(usage.output_tokens, 40);
    assert_eq!(usage.cache_read_tokens, 12);
    assert_eq!(model.unwrap(), "gpt-5.5");
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
