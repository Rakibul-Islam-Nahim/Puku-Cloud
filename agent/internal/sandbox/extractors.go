// SPDX-License-Identifier: Apache-2.0
package sandbox

// extractWorkspaceTemplate pulls workspace + template out of a store
// GetSandbox() return value (which is a map[string]any). Empty strings on miss.
func extractWorkspaceTemplate(sbAny any) (workspace, template string) {
	row, ok := sbAny.(map[string]any)
	if !ok {
		return "", ""
	}
	if t, ok := row["template"].(string); ok {
		template = t
	}
	if md, ok := row["metadata"].(map[string]string); ok {
		workspace = md["workspace"]
	}
	return workspace, template
}

// extractStatusMem pulls status + memory_mb out of a GetSandbox() map.
func extractStatusMem(sbAny any) (status string, memBytes uint64) {
	row, ok := sbAny.(map[string]any)
	if !ok {
		return "", 0
	}
	if s, ok := row["status"].(string); ok {
		status = s
	}
	switch v := row["memory_mb"].(type) {
	case int:
		memBytes = uint64(v) * 1024 * 1024
	case int64:
		memBytes = uint64(v) * 1024 * 1024
	case float64:
		memBytes = uint64(v) * 1024 * 1024
	}
	return status, memBytes
}