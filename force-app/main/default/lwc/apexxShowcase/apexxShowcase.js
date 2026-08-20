import { LightningElement } from 'lwc';
import loadAccountSummary from '@salesforce/apex/AccountService.loadAccountSummary';
import loadHotAccounts from '@salesforce/apex/AccountService.loadHotAccounts';
import loadHotContactEmails from '@salesforce/apex/AccountService.loadHotContactEmails';
import loadRevenueComparison from '@salesforce/apex/AccountService.loadRevenueComparison';

export default class ApexxShowcase extends LightningElement {
    hotAccountsData = [];
    emails = [];
    summary;
    revenueWithinTolerance = false;
    errorMessage;
    loading = false;

    connectedCallback() {
        this.refresh();
    }

    async refresh() {
        this.loading = true;
        this.errorMessage = undefined;

        try {
            const [hotAccounts, emails, summary, revenueWithinTolerance] = await Promise.all([
                loadHotAccounts(),
                loadHotContactEmails(),
                loadAccountSummary(),
                loadRevenueComparison()
            ]);

            this.hotAccountsData = hotAccounts ?? [];
            this.emails = emails ?? [];
            this.summary = summary;
            this.revenueWithinTolerance = revenueWithinTolerance;
        } catch (error) {
            this.hotAccountsData = [];
            this.emails = [];
            this.summary = undefined;
            this.revenueWithinTolerance = false;
            this.errorMessage = this.normalizeError(error);
        } finally {
            this.loading = false;
        }
    }

    get metrics() {
        return [
            {
                label: 'Demo accounts',
                value: this.summary?.names?.length ?? 0
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
        return this.hotAccountsData.map((account) => ({
            ...account,
            url: `/${account.Id}`
        }));
    }

    get hotCount() {
        return this.summary?.hotCount ?? 0;
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
        return this.summary?.firstHot?.Name ?? 'None';
    }

    get allHaveNumbersLabel() {
        return this.summary?.allHaveNumbers ? 'Yes' : 'No';
    }

    get revenueWithinToleranceLabel() {
        return this.revenueWithinTolerance ? 'Yes' : 'No';
    }

    normalizeError(error) {
        if (Array.isArray(error?.body)) {
            return error.body.map((entry) => entry.message).join(', ');
        }

        return error?.body?.message || error?.message || 'Unexpected Error';
    }
}
