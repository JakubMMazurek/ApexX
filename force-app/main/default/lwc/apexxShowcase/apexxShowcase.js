import { LightningElement } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import loadAccountSummary from '@salesforce/apex/AccountService.loadAccountSummary';
import loadNormalizedContactEmails from '@salesforce/apex/AccountService.loadNormalizedContactEmails';
import loadPriorityAccounts from '@salesforce/apex/AccountService.loadPriorityAccounts';
import loadRevenueComparison from '@salesforce/apex/AccountService.loadRevenueComparison';
import loadRenewalWork from '@salesforce/apex/AccountService.loadRenewalWork';
import saveAccount from '@salesforce/apex/AccountService.save';
import triggerUserFriendlyError from '@salesforce/apex/AccountService.triggerUserFriendlyError';

export default class ApexxShowcase extends LightningElement {
    priorityAccountsData = [];
    renewalWorkData = [];
    emails = [];
    summary;
    revenueWithinTolerance = false;
    errorMessage;
    handledErrorMessage;
    lastSavedAccountName;
    selectedAccountId;
    editedAccountName = '';
    loading = false;
    savingAccount = false;
    triggeringError = false;

    connectedCallback() {
        this.refresh();
    }

    async refresh() {
        this.loading = true;
        this.errorMessage = undefined;

        try {
            const [priorityAccounts, renewalWork, emails, summary, revenueWithinTolerance] = await Promise.all([
                loadPriorityAccounts(),
                loadRenewalWork(),
                loadNormalizedContactEmails(),
                loadAccountSummary(),
                loadRevenueComparison()
            ]);

            this.priorityAccountsData = priorityAccounts ?? [];
            this.renewalWorkData = renewalWork ?? [];
            this.emails = emails ?? [];
            this.summary = summary;
            this.revenueWithinTolerance = revenueWithinTolerance;
            this.syncEditableAccount();
        } catch (error) {
            this.priorityAccountsData = [];
            this.renewalWorkData = [];
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
            this.showToast('No error was thrown', 'The demo error method completed successfully.', 'info');
        } catch (error) {
            this.handledErrorMessage = this.normalizeError(error);
            this.showToast('Handled error', this.handledErrorMessage, 'error');
        } finally {
            this.triggeringError = false;
        }
    }

    async saveDemoAccount() {
        const account = this.priorityAccountsData.find((item) => item.Id === this.selectedAccountId);

        if (!account) {
            this.showToast('Nothing to save', 'Choose a priority account before running the save example.', 'warning');
            return;
        }

        if (!this.editedAccountName.trim()) {
            this.showToast('Name required', 'Enter an account name before saving.', 'warning');
            return;
        }

        this.savingAccount = true;
        this.lastSavedAccountName = undefined;

        try {
            const savedAccount = await saveAccount({
                account: {
                    sobjectType: 'Account',
                    Id: account.Id,
                    Name: this.editedAccountName
                },
                validate: true
            });

            this.lastSavedAccountName = savedAccount.Name;
            this.editedAccountName = savedAccount.Name;
            this.showToast('Account saved', `${savedAccount.Name} was saved through the decorated ApexX method.`, 'success');
            await this.refresh();
        } catch (error) {
            this.showToast('Save failed', this.normalizeError(error), 'error');
        } finally {
            this.savingAccount = false;
        }
    }

    handleSelectedAccountChange(event) {
        this.selectedAccountId = event.detail.value;
        const account = this.priorityAccountsData.find((item) => item.Id === this.selectedAccountId);
        this.editedAccountName = account?.Name ?? '';
    }

    handleAccountNameChange(event) {
        this.editedAccountName = event.detail.value;
    }

    syncEditableAccount() {
        if (this.priorityAccountsData.length === 0) {
            this.selectedAccountId = undefined;
            this.editedAccountName = '';
            return;
        }

        const selectedStillExists = this.priorityAccountsData.some(
            (account) => account.Id === this.selectedAccountId
        );

        if (!selectedStillExists) {
            this.selectedAccountId = this.priorityAccountsData[0].Id;
        }

        const selected = this.priorityAccountsData.find(
            (account) => account.Id === this.selectedAccountId
        );

        if (!this.editedAccountName || !selectedStillExists) {
            this.editedAccountName = selected?.Name ?? '';
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
            },
            {
                label: 'Renewal work',
                value: this.renewalWorkCount
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

    get saveDisabled() {
        return this.loading || this.savingAccount || !this.selectedAccountId || !this.editedAccountName.trim();
    }

    get accountOptions() {
        return this.priorityAccountsData.map((account) => ({
            label: account.Name,
            value: account.Id
        }));
    }

    get hasEditableAccounts() {
        return this.accountOptions.length > 0;
    }

    get renewalWork() {
        return this.renewalWorkData.map((item) => ({
            ...item,
            url: `/${item.accountId}`
        }));
    }

    get renewalWorkCount() {
        return this.renewalWork.length;
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

    get hasRenewalWork() {
        return this.renewalWork.length > 0;
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

    showToast(title, message, variant) {
        this.dispatchEvent(
            new ShowToastEvent({
                title,
                message,
                variant
            })
        );
    }

    normalizeError(error) {
        if (Array.isArray(error?.body)) {
            return error.body.map((entry) => entry.message).join(', ');
        }

        return error?.body?.message || error?.message || 'Unexpected Error';
    }
}
