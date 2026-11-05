import { defineConfig } from 'vitest/config';

// The tests were written for the approval workflow; the software itself defaults to "no approvals" (uploads are used straight away).
export default defineConfig({ test: { env: { APPROVALS_REQUIRED: 'true' } } });
