
import { ensureCitiesLoaded } from 'src/alert_handler';
import { connect } from 'src/server';
import { log } from 'src/utils';

// ── Start ───────────────────────────────────────────────────────────────────

log('🛡️  Red Alert Monitor — watching for alerts');

ensureCitiesLoaded();
connect();
