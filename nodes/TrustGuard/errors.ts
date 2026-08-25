import {
	AUTH_FAILED,
	ENTITLEMENTS,
	REQUEST_FAILED,
	TRANSFORM_MISSING,
	UNKNOWN_VERDICT,
	UNREACHABLE,
} from './types';

export class TrustGuardError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TrustGuardError';
	}
}

export class TrustGuardUnreachableError extends TrustGuardError {
	constructor(message = UNREACHABLE) {
		super(message);
		this.name = 'TrustGuardUnreachableError';
	}
}

export class TrustGuardAuthError extends TrustGuardError {
	constructor(message = AUTH_FAILED) {
		super(message);
		this.name = 'TrustGuardAuthError';
	}
}

export class TrustGuardEntitlementError extends TrustGuardError {
	constructor(message = ENTITLEMENTS) {
		super(message);
		this.name = 'TrustGuardEntitlementError';
	}
}

export class TrustGuardRequestError extends TrustGuardError {
	constructor(message = REQUEST_FAILED) {
		super(message);
		this.name = 'TrustGuardRequestError';
	}
}

export class TrustGuardUnknownVerdictError extends TrustGuardError {
	constructor(message = UNKNOWN_VERDICT) {
		super(message);
		this.name = 'TrustGuardUnknownVerdictError';
	}
}

export class TrustGuardTransformError extends TrustGuardError {
	reason: string;

	constructor(reason: string) {
		super(TRANSFORM_MISSING);
		this.name = 'TrustGuardTransformError';
		this.reason = reason;
	}
}
