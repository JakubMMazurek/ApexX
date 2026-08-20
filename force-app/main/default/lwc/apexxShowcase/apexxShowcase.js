import { LightningElement } from 'lwc';
import loadShowcase from '@salesforce/apex/AccountService.loadShowcase';

export default class ApexxShowcase extends LightningElement {
    data;
    errorMessage;
    loading = false;

    connectedCallback() {
        this.refresh();
    }

    async refresh() {
        this.loading = true;
        this.errorMessage = undefined;

        try {
            this.data = await loadShowcase();
        } catch (error) {
            this.data = undefined;
            this.errorMessage = this.normalizeError(error);
        } finally {
            this.loading = false;
        }
    }

    get metrics() {
        return [
            {
                label: 'Accounts scanned',
                value: this.data?.totalAccounts ?? 0
            },
            {
                label: 'Hot accounts',
                value: this.hotCount
            },
            {
                label: 'Contact emails',
                value: this.emailCount
            }
        ];
    }

    get hotAccounts() {
        return (this.data?.hotAccounts ?? []).map((account) => ({
            ...account,
            url: `/${account.Id}`
        }));
    }

    get emails() {
        return this.data?.hotContactEmails ?? [];
    }

    get hotCount() {
        return this.data?.summary?.hotCount ?? 0;
    }

    get emailCount() {
        return this.emails.length;
    }

    get hasHotAccounts() {
        return this.hotAccounts.length > 0;
    }

    get hasEmails() {
        return this.emails.length > 0;
    }

    get firstHotName() {
        return this.data?.summary?.firstHot?.Name ?? 'None';
    }

    get allHaveNumbersLabel() {
        return this.data?.summary?.allHaveNumbers ? 'Yes' : 'No';
    }

    get revenueWithinToleranceLabel() {
        return this.data?.revenueWithinTolerance ? 'Yes' : 'No';
    }

    normalizeError(error) {
        if (Array.isArray(error?.body)) {
            return error.body.map((entry) => entry.message).join(', ');
        }

        return error?.body?.message || error?.message || 'Unexpected Error';
    }
}
