//! 推理链（reasoning_content）处理
//!
//! DeepSeek R1 等模型会在响应中返回推理过程，需要特殊处理以保留推理链。
//!
//! TODO: Week 1 Day 5 实现（当前已在 chat_to_codex.rs 中实现）

// 当前实现已集成在 chat_to_codex.rs 的 StreamTransformer 中
// 未来可能需要独立的工具函数处理更复杂的推理链格式
