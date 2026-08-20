import { LightningElement } from 'lwc';
import loadAccountSummary from '@salesforce/apex/AccountService.loadAccountSummary';
import loadNormalizedContactEmails from '@salesforce/apex/AccountService.loadNormalizedContactEmails';
import loadPriorityAccounts from '@salesforce/apex/AccountService.loadPriorityAccounts';
import loadRevenueComparison from '@salesforce/apex/AccountService.loadRevenueComparison';
import triggerUserFriendlyError from '@salesforce/apex/AccountService.triggerUserFriendlyError';

export default class ApexxShowcase extends LightningElement {
    priorityAccountsData = [];
    emails = [];
    summary;
    revenueWithinTolerance = false;
    errorMessage;
    handledErrorMessage;
    loading = false;
    triggeringError = false;

    connectedCallback() {
        this.refresh();
    }

    async refresh() {
        this.loading = true;
        this.errorMessage = undefined;

        try {
            const [priorityAccounts, emails, summary, revenueWithinTolerance] = await Promise.all([
                loadPriorityAccounts(),
                loadNormalizedContactEmails(),
                loadAccountSummary(),
                loadRevenueComparison()
            ]);

            this.priorityAccountsData = priorityAccounts ?? [];
            this.emails = emails ?? [];
            this.summary = summary;
            this.revenueWithinTolerance = revenueWithinTolerance;
        } catch (error) {
            this.priorityAccountsData = [];
            this.emails = [];
            this.summary = undefined;
            this.revenueWithinTolerance = false;
            this.errorMessage = this.normalizeError(error);
        } finally {
            this.loading = false;
        }
    }

    async triggerError() {
        this.triggeringError = true;
        this.handledErrorMessage = undefined;

        try {
            await triggerUserFriendlyError();
            this.handledErrorMessage = 'No error was thrown.';
        } catch (error) {
            this.handledErrorMessage = this.normalizeError(error);
        } finally {
            this.triggeringError = false;
        }
    }

    get metrics() {
        return [
            {
                label: 'Demo accounts',
                value: this.summary?.names?.length ?? 0
            },
            {
                label: 'Priority accounts',
                value: this.priorityCount
            },
            {
                label: 'Contact emails',
                value: this.emailCount
            }
        ];
    }

    get priorityAccounts() {
        return this.priorityAccountsData.map((account) => ({
            ...account,
            url: `/${account.Id}`
        }));
    }

    get priorityCount() {
        return this.priorityAccounts.length;
    }

    get hotCount() {
        return this.summary?.hotCount ?? 0;
    }

    get emailCount() {
        return this.emails.length;
    }

    get hasPriorityAccounts() {
        return this.priorityAccounts.length > 0;
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
