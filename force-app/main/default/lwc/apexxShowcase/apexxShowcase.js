import { LightningElement } from 'lwc';
import loadShowcaseOverview from '@salesforce/apex/AccountService.loadShowcaseOverview';
import runEmailPipeline from '@salesforce/apex/AccountService.runEmailPipeline';
import runPortfolioBriefing from '@salesforce/apex/AccountService.runPortfolioBriefing';
import runRenewalStrategy from '@salesforce/apex/AccountService.runRenewalStrategy';
import runRevenueComparison from '@salesforce/apex/AccountService.runRevenueComparison';
import runTupleDemo from '@salesforce/apex/AccountService.runTupleDemo';
import triggerRawError from '@salesforce/apex/AccountService.triggerRawError';
import triggerUserFriendlyError from '@salesforce/apex/AccountService.triggerUserFriendlyError';
import {
    EMAIL_APEXX,
    STRATEGY_APEXX,
    TUPLE_APEXX,
    DEFAULT_APEXX,
    DECORATOR_APEXX,
    DECORATOR_IMPLEMENTATION,
    DECORATOR_CONTRACT,
    WORKFLOW_APEXX,
    SCRIPT_APEXX,
    SCRIPT_GENERATED
} from './showcaseSource';

const EMAIL_APEX = `public static EmailPipelineResult inspectPortfolio(List<Account> accounts) {
    List<String> emails = new List<String>();
    Integer contactCount = 0;
    Integer hotCount = 0;
    Boolean anyMissingNumber = false;
    Boolean allHaveRevenue = true;
    Account firstHighValue;

    for (Account account : accounts) {
        if (account.Rating == 'Hot') {
            hotCount++;
        }
        if (account.AccountNumber == null) {
            anyMissingNumber = true;
        }
        if (account.AnnualRevenue == null) {
            allHaveRevenue = false;
        }
        if (firstHighValue == null && account.AnnualRevenue != null
            && account.AnnualRevenue >= 250000) {
            firstHighValue = account;
        }

        for (Contact contact : account.Contacts) {
            contactCount++;
            if (contact.Email != null && contact.Email.contains('@')) {
                emails.add(contact.Email.trim().toLowerCase());
            }
        }
    }

    return new EmailPipelineResult(
        accounts.size(), contactCount, emails.size(), emails,
        hotCount, anyMissingNumber, allHaveRevenue,
        firstHighValue == null ? null : firstHighValue.Name
    );
}`;

const STRATEGY_APEX = `private static Boolean matchesMode(Account account, String mode) {
    if (mode == 'Revenue Exposure') {
        return account.AnnualRevenue != null
            && account.AnnualRevenue >= 250000;
    }
    if (mode == 'Sales Ready') {
        return account.Rating == 'Hot'
            && account.AccountNumber != null;
    }
    return account.AccountNumber == null;
}

private static String reasonFor(String mode) {
    if (mode == 'Revenue Exposure') {
        return 'Revenue exposure';
    }
    if (mode == 'Sales Ready') {
        return 'Sales ready';
    }
    return 'Missing account number';
}

public static StrategyResult evaluate(List<Account> accounts, String mode) {
    Integer matches = 0;
    Account firstMatch;
    List<AccountWorkItem> work = new List<AccountWorkItem>();
    String reason = reasonFor(mode);

    for (Account account : accounts) {
        Boolean selected = matchesMode(account, mode);
        if (selected) {
            matches++;
            if (firstMatch == null) {
                firstMatch = account;
            }
        }
        work.add(new AccountWorkItem(
            account.Id,
            account.Name,
            account.OwnerId,
            selected ? 'High' : 'Normal',
            selected ? reason : 'Standard renewal'
        ));
    }
    return new StrategyResult(
        mode,
        accounts.size(),
        matches,
        firstMatch == null ? null : firstMatch.Name,
        work
    );
}`;

const TUPLE_APEX = `// AccountSignalProvider.cls
public class AccountSignal {
    public Decimal revenuePerEmployee;
    public Boolean needsReview;

    public AccountSignal(
        Decimal revenuePerEmployee,
        Boolean needsReview
    ) {
        this.revenuePerEmployee = revenuePerEmployee;
        this.needsReview = needsReview;
    }
}

public static Map<Id, AccountSignal> calculate(List<Account> accounts) {
    Map<Id, AccountSignal> signalsByAccountId =
        new Map<Id, AccountSignal>();

    for (Account account : accounts) {
        Decimal revenuePerEmployee =
            account.AnnualRevenue == null
            || account.NumberOfEmployees == null
            || account.NumberOfEmployees <= 0
                ? null
                : account.AnnualRevenue / account.NumberOfEmployees;
        Boolean needsReview = account.AccountNumber == null
            || revenuePerEmployee == null
            || revenuePerEmployee < 10000;

        signalsByAccountId.put(
            account.Id,
            new AccountSignal(revenuePerEmployee, needsReview)
        );
    }

    return signalsByAccountId;
}

// AccountSignalConsumer.cls
public static AccountService.TupleDemoResult buildResult(List<Account> accounts) {
    Map<Id, AccountSignalProvider.AccountSignal> signalsByAccountId =
        AccountSignalProvider.calculate(accounts);
    List<AccountService.AccountSignal> signals =
        new List<AccountService.AccountSignal>();
    Integer reviewCount = 0;

    for (Account account : accounts) {
        AccountSignalProvider.AccountSignal signal =
            signalsByAccountId.get(account.Id);
        if (signal.needsReview) {
            reviewCount++;
        }
        signals.add(new AccountService.AccountSignal(
            account.Id,
            account.Name,
            signal.revenuePerEmployee,
            signal.needsReview
        ));
    }

    return new AccountService.TupleDemoResult(
        accounts.size(),
        reviewCount,
        signals
    );
}`;

const DEFAULT_APEX = `// 1 · both defaults
Boolean exactMatch = compareRevenue(left, right);

// 2 · override absolute tolerance
Boolean within1000 = compareRevenue(left, right, 1000);

// 3 · override both tolerances
Boolean withinEither = compareRevenue(left, right, 250, 0.5);

public static Boolean compareRevenue(Account left, Account right) {
    return compareRevenue(left, right, 0, 0);
}

public static Boolean compareRevenue(
    Account left,
    Account right,
    Decimal absoluteTolerance
) {
    return compareRevenue(left, right, absoluteTolerance, 0);
}

public static Boolean compareRevenue(
    Account left,
    Account right,
    Decimal absoluteTolerance,
    Decimal percentageTolerance
) {
    if (left.AnnualRevenue == null || right.AnnualRevenue == null) {
        return false;
    }
    Decimal difference = (left.AnnualRevenue - right.AnnualRevenue).abs();
    Decimal baseline = left.AnnualRevenue.abs();
    Decimal percentage = baseline == 0
        ? (difference == 0 ? 0 : 100)
        : difference / baseline * 100;
    return difference <= absoluteTolerance
        || percentage <= percentageTolerance;
}`;

const DECORATOR_APEX = `@AuraEnabled
public static void triggerUserFriendlyError() {
    try {
        String missingValue = null;
        missingValue.trim();
    } catch (Exception ex) {
        throw new LwcUtil().getUserFriendlyException(
            ex,
            new List<Type>(),
            'The operation failed safely. Internal details were hidden.'
        );
    }
}`;

const WORKFLOW_APEX = `// PortfolioRuleProvider.cls
public static final Decimal EXPOSURE_THRESHOLD = 250000;

public static Boolean matchesMode(Account account, String mode) {
    if (mode == 'Revenue Exposure') {
        return account.AnnualRevenue != null
            && account.AnnualRevenue >= EXPOSURE_THRESHOLD;
    }
    if (mode == 'Sales Ready') {
        return account.Rating == 'Hot'
            && account.AccountNumber != null;
    }
    return account.AccountNumber == null;
}

public static String reasonFor(String mode) {
    if (mode == 'Revenue Exposure') {
        return 'Revenue exposure';
    }
    if (mode == 'Sales Ready') {
        return 'Sales ready';
    }
    return 'Missing account number';
}

// AccountService.cls · four of the class's thirteen decorated endpoints
@AuraEnabled
public static PortfolioBriefing runPortfolioBriefing(
    String mode,
    Decimal minimumRevenue
) {
    try {
        List<Account> accounts = demoAccountsWithContacts();
        return minimumRevenue == null
            ? buildPortfolioBriefing(accounts, mode)
            : buildPortfolioBriefing(accounts, mode, minimumRevenue);
    } catch (Exception ex) {
        throw new LwcUtil().getUserFriendlyException(
            ex,
            new List<Type>(),
            'Unable to build the portfolio briefing.'
        );
    }
}

@AuraEnabled
public static EmailPipelineResult runEmailPipeline() {
    try {
        return inspectPortfolio(demoAccountsWithContacts());
    } catch (Exception ex) {
        throw new LwcUtil()
            .getUserFriendlyException(ex, new List<Type>(), null);
    }
}

@AuraEnabled
public static StrategyResult runRenewalStrategy(String mode) {
    try {
        return evaluateMode(demoAccounts(), mode);
    } catch (Exception ex) {
        throw new LwcUtil()
            .getUserFriendlyException(ex, new List<Type>(), null);
    }
}

@AuraEnabled
public static TupleDemoResult runTupleDemo() {
    try {
        return AccountSignalConsumer.buildResult(demoAccounts());
    } catch (Exception ex) {
        throw new LwcUtil()
            .getUserFriendlyException(ex, new List<Type>(), null);
    }
}

public static List<AccountWorkItem> buildSelectedWork(
    List<Account> accounts,
    String reason
) {
    List<AccountWorkItem> work = new List<AccountWorkItem>();
    for (Account account : accounts) {
        work.add(new AccountWorkItem(
            account.Id,
            account.Name,
            account.OwnerId,
            'High',
            reason
        ));
    }
    return work;
}

public static PortfolioBriefing buildPortfolioBriefing(List<Account> accounts) {
    return buildPortfolioBriefing(accounts, 'Revenue Exposure', 100000);
}

public static PortfolioBriefing buildPortfolioBriefing(
    List<Account> accounts,
    String mode
) {
    return buildPortfolioBriefing(accounts, mode, 100000);
}

public static PortfolioBriefing buildPortfolioBriefing(
    List<Account> accounts,
    String mode,
    Decimal minimumRevenue
) {
    String escalationReason = PortfolioRuleProvider.reasonFor(mode);
    List<Account> selected = new List<Account>();
    List<String> stakeholderEmails = new List<String>();

    // One fused pass: conventional Apex at its most efficient.
    for (Account account : accounts) {
        if (account.AnnualRevenue == null
            || account.AnnualRevenue < minimumRevenue
            || !PortfolioRuleProvider.matchesMode(account, mode)) {
            continue;
        }

        selected.add(account);

        for (Contact contact : account.Contacts) {
            if (contact.Email != null) {
                stakeholderEmails.add(contact.Email.trim().toLowerCase());
            }
        }
    }

    List<AccountWorkItem> workItems = buildSelectedWork(
        selected,
        escalationReason
    );

    return new PortfolioBriefing(
        mode,
        minimumRevenue,
        PortfolioRuleProvider.EXPOSURE_THRESHOLD,
        accounts.size(),
        selected.size(),
        workItems,
        stakeholderEmails
    );
}`;

// Measured off the panels themselves, so the figure on screen can never
// disagree with the code beside it. Brevity is a side effect the deck reports,
// not the case it makes -- the per-feature panels argue from maintenance cost.
const reduction = (apex, apexx) =>
    Math.round((1 - apexx.split('\n').length / apex.split('\n').length) * 100);

// A panel renders one <li> per line so CSS can number the gutter. The number is
// generated content, so selecting the panel still copies just the code.
const toLines = source =>
    source.split('\n').map((text, index) => ({ key: `line-${index}`, text }));

export default class ApexxShowcase extends LightningElement {
    accounts = [];
    overviewLoading = true;
    overviewError;

    emailResult;
    emailLoading = false;
    emailError;

    workflowResult;
    workflowLoading = false;
    workflowError;
    workflowMode = 'Revenue Exposure';
    workflowThreshold = 'default';

    strategyResult;
    strategyLoading = false;
    strategyError;
    strategyMode = 'Revenue Exposure';

    tupleResult;
    tupleLoading = false;
    tupleError;

    comparisonResult;
    comparisonLoading = false;
    comparisonError;
    toleranceChoice = 'exact';

    decoratorResult;
    decoratorLoading = false;
    rawErrorResult;
    rawErrorLoading = false;

    emailApexRows = toLines(EMAIL_APEX);
    emailApexXRows = toLines(EMAIL_APEXX);
    strategyApexRows = toLines(STRATEGY_APEX);
    strategyApexXRows = toLines(STRATEGY_APEXX);
    tupleApexRows = toLines(TUPLE_APEX);
    tupleApexXRows = toLines(TUPLE_APEXX);
    defaultApexRows = toLines(DEFAULT_APEX);
    defaultApexXRows = toLines(DEFAULT_APEXX);
    decoratorApexRows = toLines(DECORATOR_APEX);
    decoratorApexXRows = toLines(DECORATOR_APEXX);
    decoratorImplementationRows = toLines(DECORATOR_IMPLEMENTATION);
    decoratorContractRows = toLines(DECORATOR_CONTRACT);
    scriptApexXRows = toLines(SCRIPT_APEXX);
    scriptGeneratedRows = toLines(SCRIPT_GENERATED);
    workflowApexRows = toLines(WORKFLOW_APEX);
    workflowApexXRows = toLines(WORKFLOW_APEXX);
    workflowApexLines = WORKFLOW_APEX.split('\n').length;
    workflowApexXLines = WORKFLOW_APEXX.split('\n').length;
    workflowReduction = reduction(WORKFLOW_APEX, WORKFLOW_APEXX);

    connectedCallback() {
        this.loadOverview();
    }

    async loadOverview() {
        this.overviewLoading = true;
        this.overviewError = undefined;

        try {
            const overview = await loadShowcaseOverview();
            this.accounts = (overview?.records ?? []).map((account) => ({
                ...account,
                url: `/${account.accountId}`,
                numberLabel: account.accountNumber ?? 'No account number'
            }));
        } catch (error) {
            this.accounts = [];
            this.overviewError = this.normalizeError(error);
        } finally {
            this.overviewLoading = false;
        }
    }

    async executeEmailPipeline() {
        this.emailLoading = true;
        this.emailError = undefined;
        this.emailResult = undefined;

        try {
            this.emailResult = await runEmailPipeline();
        } catch (error) {
            this.emailError = this.normalizeError(error);
        } finally {
            this.emailLoading = false;
        }
    }

    handleWorkflowMode(event) {
        this.workflowMode = event.detail.value;
    }

    handleWorkflowThreshold(event) {
        this.workflowThreshold = event.detail.value;
    }

    async executeWorkflow() {
        this.workflowLoading = true;
        this.workflowError = undefined;
        this.workflowResult = undefined;

        const minimumRevenue = this.workflowThreshold === 'default'
            ? null
            : Number(this.workflowThreshold);

        try {
            const result = await runPortfolioBriefing({
                mode: this.workflowMode,
                minimumRevenue
            });
            this.workflowResult = {
                ...result,
                workItems: (result?.workItems ?? []).map((item) => ({
                    ...item,
                    url: `/${item.accountId}`
                }))
            };
        } catch (error) {
            this.workflowError = this.normalizeError(error);
        } finally {
            this.workflowLoading = false;
        }
    }

    handleStrategyMode(event) {
        this.strategyMode = event.detail.value;
    }

    async executeStrategy() {
        this.strategyLoading = true;
        this.strategyError = undefined;
        this.strategyResult = undefined;

        try {
            const result = await runRenewalStrategy({ mode: this.strategyMode });
            this.strategyResult = {
                ...result,
                items: (result?.items ?? []).map((item) => ({
                    ...item,
                    url: `/${item.accountId}`,
                    priorityClass: item.priority === 'High' ? 'priority priority_high' : 'priority'
                }))
            };
        } catch (error) {
            this.strategyError = this.normalizeError(error);
        } finally {
            this.strategyLoading = false;
        }
    }

    async executeTupleDemo() {
        this.tupleLoading = true;
        this.tupleError = undefined;
        this.tupleResult = undefined;

        try {
            const result = await runTupleDemo();
            this.tupleResult = {
                ...result,
                signals: (result?.signals ?? []).map((signal) => ({
                    ...signal,
                    url: `/${signal.accountId}`,
                    reviewLabel: signal.needsReview ? 'Review' : 'Healthy',
                    reviewClass: signal.needsReview
                        ? 'priority priority_high'
                        : 'priority'
                }))
            };
        } catch (error) {
            this.tupleError = this.normalizeError(error);
        } finally {
            this.tupleLoading = false;
        }
    }

    handleToleranceChoice(event) {
        this.toleranceChoice = event.currentTarget.dataset.value;
    }

    get exactChoiceClass() {
        return this.callShapeChoiceClass('exact');
    }

    get absoluteChoiceClass() {
        return this.callShapeChoiceClass('absolute');
    }

    get blendedChoiceClass() {
        return this.callShapeChoiceClass('blended');
    }

    get exactChoiceSelected() {
        return this.toleranceChoice === 'exact';
    }

    get absoluteChoiceSelected() {
        return this.toleranceChoice === 'absolute';
    }

    get blendedChoiceSelected() {
        return this.toleranceChoice === 'blended';
    }

    callShapeChoiceClass(value) {
        return this.toleranceChoice === value
            ? 'callShapeOption callShapeOption_selected'
            : 'callShapeOption';
    }

    async executeComparison() {
        this.comparisonLoading = true;
        this.comparisonError = undefined;
        this.comparisonResult = undefined;

        let absoluteTolerance = null;
        let percentageTolerance = null;

        if (this.toleranceChoice === 'absolute') {
            absoluteTolerance = 1000;
        } else if (this.toleranceChoice === 'blended') {
            absoluteTolerance = 250;
            percentageTolerance = 0.5;
        }

        try {
            this.comparisonResult = await runRevenueComparison({
                absoluteTolerance,
                percentageTolerance
            });
        } catch (error) {
            this.comparisonError = this.normalizeError(error);
        } finally {
            this.comparisonLoading = false;
        }
    }

    async executeDecorator() {
        this.decoratorLoading = true;
        this.decoratorResult = undefined;

        try {
            await triggerUserFriendlyError();
            this.decoratorResult = {
                succeeded: true,
                title: 'The operation unexpectedly succeeded',
                message: 'No exception reached the decorator.'
            };
        } catch (error) {
            this.decoratorResult = {
                succeeded: false,
                title: 'Safe client response received',
                message: this.normalizeError(error)
            };
        } finally {
            this.decoratorLoading = false;
        }
    }

    async executeRawError() {
        this.rawErrorLoading = true;
        this.rawErrorResult = undefined;

        try {
            await triggerRawError();
            this.rawErrorResult = {
                title: 'The operation unexpectedly succeeded',
                exceptionType: 'No exception',
                message: 'The raw method completed without throwing.',
                stackTrace: undefined
            };
        } catch (error) {
            this.rawErrorResult = {
                title: 'Raw Apex exception received',
                exceptionType: error?.body?.exceptionType || 'Apex exception',
                message: this.normalizeError(error),
                stackTrace: error?.body?.stackTrace
            };
        } finally {
            this.rawErrorLoading = false;
        }
    }

    get hasAccounts() {
        return this.accounts.length > 0;
    }

    get strategyOptions() {
        return [
            { label: 'Revenue exposure', value: 'Revenue Exposure' },
            { label: 'Sales ready', value: 'Sales Ready' },
            { label: 'Data quality gap', value: 'Data Quality' }
        ];
    }

    get workflowThresholdOptions() {
        return [
            { label: 'Default · $100k', value: 'default' },
            { label: '$90k', value: '90000' }
        ];
    }

    get comparisonVerdict() {
        return this.comparisonResult?.matches ? 'Within tolerance' : 'Outside tolerance';
    }

    get comparisonVerdictClass() {
        return this.comparisonResult?.matches
            ? 'verdict verdict_success'
            : 'verdict verdict_neutral';
    }

    get hasErrorComparison() {
        return Boolean(this.rawErrorResult || this.decoratorResult);
    }

    get errorDemoLoading() {
        return this.rawErrorLoading || this.decoratorLoading;
    }

    normalizeError(error) {
        if (Array.isArray(error?.body)) {
            return error.body.map((entry) => entry.message).join(', ');
        }

        return error?.body?.message || error?.message || 'Unexpected Error';
    }
}
