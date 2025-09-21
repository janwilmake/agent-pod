import { AppError } from '../utils/errors';

export type CssProvisioningConfig = {
    baseUrl?: string;
    provisionUrl: string;
    adminToken?: string;
    oidcIssuer?: string;
};

export type CssProvisioningInput = {
    slug: string;
    email: string;
    name?: string;
    password: string;
};

export type CssProvisioningResult = {
    podBaseUrl: string;
    webId: string;
};

export class CssProvisioningService {
    constructor(private readonly config: CssProvisioningConfig) {}

    async provisionPod(input: CssProvisioningInput): Promise<CssProvisioningResult> {
        const headers: Record<string, string> = {
            'content-type': 'application/json',
        };

        if (this.config.adminToken) {
            headers.authorization = `Bearer ${this.config.adminToken}`;
        }

        const body = JSON.stringify({
            slug: input.slug,
            email: input.email,
            name: input.name,
            password: input.password,
            confirmPassword: input.password,
            oidcIssuer: this.config.oidcIssuer,
        });

        const response = await fetch(this.config.provisionUrl, {
            method: 'POST',
            headers,
            body,
        });

        const payload = await this.safeJson(response);

        if (!response.ok) {
            throw new AppError('Failed to provision Solid pod', response.status || 502, {
                response: payload ?? await response.text().catch(() => undefined),
            });
        }

        const result = this.parseProvisioningResult(payload, input.slug);
        if (!result) {
            throw new AppError('Solid pod provisioning response was missing required data', 502, {
                response: payload,
            });
        }

        return result;
    }

    private async safeJson(response: Response): Promise<unknown | null> {
        try {
            return await response.clone().json();
        } catch {
            return null;
        }
    }

    private parseProvisioningResult(payload: unknown, slug: string): CssProvisioningResult | null {
        if (!payload || typeof payload !== 'object') {
            return this.fallbackResult(slug);
        }

        const record = payload as Record<string, unknown>;
        const webId = this.pickString(record, ['webId', 'webID', 'web_id']);
        const podBaseUrl =
            this.pickString(record, ['podBaseUrl', 'podBaseURL', 'pod_base_url', 'baseUrl', 'baseURL'])
            ?? this.extractFromNested(record, ['pod', 'baseUrl']);

        const finalBase = podBaseUrl ?? this.buildDefaultPodBase(slug);
        const finalWebId = webId ?? this.extractFromNested(record, ['pod', 'webId']);

        if (!finalBase || !finalWebId) {
            return null;
        }

        return {
            podBaseUrl: finalBase,
            webId: finalWebId,
        };
    }

    private pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
        for (const key of keys) {
            const value = record[key];
            if (typeof value === 'string' && value.trim().length > 0) {
                return value.trim();
            }
        }
        return undefined;
    }

    private extractFromNested(record: Record<string, unknown>, path: string[]): string | undefined {
        let current: unknown = record;
        for (const segment of path) {
            if (!current || typeof current !== 'object') {
                return undefined;
            }
            current = (current as Record<string, unknown>)[segment];
        }
        return typeof current === 'string' ? current : undefined;
    }

    private buildDefaultPodBase(slug: string): string | undefined {
        if (!this.config.baseUrl) {
            return undefined;
        }
        const base = this.config.baseUrl.replace(/\/$/, '');
        return `${base}/${encodeURIComponent(slug)}/`;
    }

    private fallbackResult(slug: string): CssProvisioningResult | null {
        const base = this.buildDefaultPodBase(slug);
        if (!base) {
            return null;
        }
        return {
            podBaseUrl: base,
            webId: `${base}profile/card#me`,
        };
    }
}