// lib/handlers.patch.js
// MERGE INSTRUCTION:
// Add the lines from this file into the engine's existing lib/handlers.js
// dispatcher. Do not replace the existing file — append the new handlers.

const codeWriter = require("./agents/code_writer");

// =====================================================================
// In your existing lib/handlers.js, locate the dispatcher (likely a
// switch on task.action OR a map { action_name: handler }). Add these:
// =====================================================================

const NEW_HANDLERS = {
  github_read_file:     codeWriter.github_read_file,
  github_list_files:    codeWriter.github_list_files,
  github_create_branch: codeWriter.github_create_branch,
  github_apply_patch:   codeWriter.github_apply_patch,
  github_create_pr:     codeWriter.github_create_pr,
  github_merge_pr:      codeWriter.github_merge_pr,
};

module.exports = { NEW_HANDLERS };

// =====================================================================
// EXAMPLE INTEGRATION (adapt to your existing handlers.js shape):
//
//   const { NEW_HANDLERS } = require("./handlers.patch");
//   const HANDLERS = {
//     ...EXISTING_HANDLERS,
//     ...NEW_HANDLERS,
//   };
//
// OR if your dispatcher uses a switch:
//   case "github_read_file":     return codeWriter.github_read_file(task);
//   case "github_list_files":    return codeWriter.github_list_files(task);
//   case "github_create_branch": return codeWriter.github_create_branch(task);
//   case "github_apply_patch":   return codeWriter.github_apply_patch(task);
//   case "github_create_pr":     return codeWriter.github_create_pr(task);
//   case "github_merge_pr":      return codeWriter.github_merge_pr(task);
// =====================================================================
