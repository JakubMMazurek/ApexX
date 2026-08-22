import { LightningElement } from 'lwc';
import loadShowcaseOverview from '@salesforce/apex/AccountService.loadShowcaseOverview';
import runEmailPipeline from '@salesforce/apex/AccountService.runEmailPipeline';
import runPortfolioBriefing from '@salesforce/apex/AccountService.runPortfolioBriefing';
import runRenewalStrategy from '@salesforce/apex/AccountService.runRenewalStrategy';
import runRevenueComparison from '@salesforce/apex/AccountService.runRevenueComparison';
import runTupleDemo from '@salesforce/apex/AccountService.runTupleDemo';
import triggerRawError from '@salesforce/apex/AccountService.triggerRawError';
import triggerUserFriendlyError from '@salesforce/apex/AccountService.triggerUserFriendlyError';

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

const EMAIL_APEXX = `public static EmailPipelineResult inspectPortfolio(List<Account> accounts) {
    List<Contact> contacts = accounts.flatMap(account => account.Contacts);
    List<String> emails = contacts
        .filter(contact => contact.Email != null && contact.Email.contains('@'))
        .map(contact => contact.Email.trim().toLowerCase());
    Account firstHighValue = accounts.find(account =>
        account.AnnualRevenue != null
        && account.AnnualRevenue >= 250000
    );

    return new EmailPipelineResult(
        accounts.size(), contacts.size(), emails.size(), emails,
        accounts.count(account => account.Rating == 'Hot'),
        accounts.any(account => account.AccountNumber == null),
        accounts.all(account => account.AnnualRevenue != null),
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

const STRATEGY_APEXX = `public static StrategyResult evaluateMode(
    List<Account> accounts,
    String mode
) {
    Decimal exposureThreshold = 250000;
    Func<Account, Boolean> rule;
    String reason;

    if (mode == 'Revenue Exposure') {
        rule = (account) => {
            Decimal revenue = account.AnnualRevenue == null
                ? 0
                : account.AnnualRevenue;
            return revenue >= exposureThreshold;
        };
        reason = 'Revenue exposure';
    } else if (mode == 'Sales Ready') {
        rule = (account) => {
            Boolean hasNumber = account.AccountNumber != null;
            return account.Rating == 'Hot' && hasNumber;
        };
        reason = 'Sales ready';
    } else {
        rule = (account) => account.AccountNumber == null;
        reason = 'Missing account number';
    }
    return evaluate(accounts, mode, rule, reason);
}

private static StrategyResult evaluate(
    List<Account> accounts,
    String mode,
    Func<Account, Boolean> rule,
    String reason
) {
    Integer matches = accounts.count(account => rule(account));
    Account firstMatch = accounts.find(account => rule(account));
    List<AccountWorkItem> work = accounts.map(account => {
        Boolean selected = rule(account);
        return new AccountWorkItem(
            account.Id,
            account.Name,
            account.OwnerId,
            selected ? 'High' : 'Normal',
            selected ? reason : 'Standard renewal'
        );
    });
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
public static Set<Id> findAccountsNeedingReview(List<Account> accounts) {
    Map<Id, AccountSignalProvider.AccountSignal> signals =
        AccountSignalProvider.calculate(accounts);
    Set<Id> result = new Set<Id>();
    for (Account account : accounts) {
        AccountSignalProvider.AccountSignal signal = signals.get(account.Id);
        if (signal.needsReview) {
            result.add(account.Id);
        }
    }
    return result;
}`;

const TUPLE_APEXX = `// AccountSignalProvider.clsx
public static Map<Id, (Decimal, Boolean)> calculate(List<Account> accounts) {
    Map<Id, (Decimal, Boolean)> signalsByAccountId =
        new Map<Id, (Decimal, Boolean)>();
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
            (revenuePerEmployee, needsReview)
        );
    }
    return signalsByAccountId;
}

// AccountSignalConsumer.clsx
public static Set<Id> findAccountsNeedingReview(List<Account> accounts) {
    Map<Id, (Decimal, Boolean)> signals = AccountSignalProvider.calculate(accounts);
    Set<Id> result = new Set<Id>();
    for (Account account : accounts) {
        (Decimal revenuePerEmployee, Boolean needsReview) =
            signals.get(account.Id);
        if (needsReview) {
            result.add(account.Id);
        }
    }
    return result;
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

const DEFAULT_APEXX = `// 1 · both defaults
Boolean exactMatch = compareRevenue(left, right);

// 2 · override the first default
Boolean within1000 = compareRevenue(left, right, 1000);

// 3 · override both defaults
Boolean withinEither = compareRevenue(left, right, 250, 0.5);

public static Boolean compareRevenue(
    Account left,
    Account right,
    Decimal absoluteTolerance = 0,
    Decimal percentageTolerance = 0
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

const DECORATOR_APEXX = `@AuraEnabled
@UserFriendlyError(message = 'The operation failed safely. Internal details were hidden.')
public static void triggerUserFriendlyError() {
    String missingValue = null;
    missingValue.trim();
}`;

const DECORATOR_IMPLEMENTATION = `public with sharing class UserFriendlyError
    implements ApexX.Decorator {

    public Object handle(ApexX.Invocation ctx, ApexX.Next next) {
        try {
            return next.call();
        } catch (Exception ex) {
            List<Type> expectedTypes =
                (List<Type>) ctx.config.get('expectedTypes');
            String message =
                (String) ctx.config.get('message');

            if (expectedTypes == null) {
                expectedTypes = new List<Type>();
            }

            throw new LwcUtil().getUserFriendlyException(
                ex,
                expectedTypes,
                message
            );
        }
    }
}`;

const DECORATOR_CONTRACT = `public interface Decorator {
    Object handle(Invocation ctx, Next next);
}

public class Invocation {
    public String className;
    public String methodName;
    public List<String> parameterNames;
    public List<Object> arguments;
    public Map<String, Object> config;

    public Invocation(
        String className,
        String methodName,
        List<String> parameterNames,
        List<Object> arguments,
        Map<String, Object> config
    ) {
        this.className = className;
        this.methodName = methodName;
        this.parameterNames = parameterNames;
        this.arguments = arguments;
        this.config = config;
    }
}

public interface Next {
    Object call();
}`;

const WORKFLOW_APEX = `@AuraEnabled
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

public static PortfolioBriefing buildPortfolioBriefing(List<Account> accounts) {
    return buildPortfolioBriefing(accounts, 'Revenue Exposure', 100000);
}

public static PortfolioBriefing buildPortfolioBriefing(
    List<Account> accounts,
    String mode
) {
    return buildPortfolioBriefing(accounts, mode, 100000);
}

private static Boolean matchesMode(
    Account account,
    String mode,
    Decimal exposureThreshold
) {
    if (mode == 'Revenue Exposure') {
        return account.AnnualRevenue != null
            && account.AnnualRevenue >= exposureThreshold;
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

public static PortfolioBriefing buildPortfolioBriefing(
    List<Account> accounts,
    String mode,
    Decimal minimumRevenue
) {
    Decimal exposureThreshold = 250000;
    List<Account> selected = new List<Account>();
    List<AccountWorkItem> work = new List<AccountWorkItem>();
    List<String> emails = new List<String>();
    String reason = reasonFor(mode);

    for (Account account : accounts) {
        if (account.AnnualRevenue == null
            || account.AnnualRevenue < minimumRevenue
            || !matchesMode(account, mode, exposureThreshold)) {
            continue;
        }

        selected.add(account);
        work.add(new AccountWorkItem(
            account.Id,
            account.Name,
            account.OwnerId,
            'High',
            reason
        ));

        for (Contact contact : account.Contacts) {
            if (contact.Email != null) {
                emails.add(contact.Email.trim().toLowerCase());
            }
        }
    }

    return new PortfolioBriefing(
        mode,
        minimumRevenue,
        exposureThreshold,
        accounts.size(),
        selected.size(),
        work,
        emails
    );
}`;

const WORKFLOW_APEXX = `// PortfolioRuleProvider.clsx
public static (Func<Account, Boolean>, String, Decimal) resolve(String mode) {
    Decimal exposureThreshold = 250000;
    Func<Account, Boolean> rule;
    String reason;

    if (mode == 'Revenue Exposure') {
        rule = (account) => {
            Decimal revenue = account.AnnualRevenue == null
                ? 0
                : account.AnnualRevenue;
            return revenue >= exposureThreshold;
        };
        reason = 'Revenue exposure';
    } else if (mode == 'Sales Ready') {
        rule = (account) => {
            Boolean hasNumber = account.AccountNumber != null;
            return account.Rating == 'Hot' && hasNumber;
        };
        reason = 'Sales ready';
    } else {
        rule = (account) => account.AccountNumber == null;
        reason = 'Missing account number';
    }
    return (rule, reason, exposureThreshold);
}

// AccountService.clsx
@AuraEnabled
@UserFriendlyError(message = 'Unable to build the portfolio briefing.')
public static PortfolioBriefing runPortfolioBriefing(
    String mode,
    Decimal minimumRevenue
) {
    List<Account> accounts = demoAccountsWithContacts();
    return minimumRevenue == null
        ? buildPortfolioBriefing(accounts, mode)
        : buildPortfolioBriefing(accounts, mode, minimumRevenue);
}

public static List<AccountWorkItem> buildSelectedWork(
    List<Account> accounts,
    String reason
) {
    return accounts.map(account => new AccountWorkItem(
        account.Id, account.Name, account.OwnerId, 'High', reason
    ));
}

public static PortfolioBriefing buildPortfolioBriefing(
    List<Account> accounts,
    String mode = 'Revenue Exposure',
    Decimal minimumRevenue = 100000
) {
    (Func<Account, Boolean> matches, String reason, Decimal threshold) =
        PortfolioRuleProvider.resolve(mode);

    List<Account> selected = accounts
        .filter(account => account.AnnualRevenue != null
            && account.AnnualRevenue >= minimumRevenue)
        .filter(account => matches(account));
    List<AccountWorkItem> work = buildSelectedWork(selected, reason);
    List<String> emails = selected
        .flatMap(account => account.Contacts)
        .filter(contact => contact.Email != null)
        .map(contact => contact.Email.trim().toLowerCase());

    return new PortfolioBriefing(
        mode, minimumRevenue, threshold,
        accounts.size(), selected.size(), work, emails
    );
}`;

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

    emailApex = EMAIL_APEX;
    emailApexX = EMAIL_APEXX;
    strategyApex = STRATEGY_APEX;
    strategyApexX = STRATEGY_APEXX;
    tupleApex = TUPLE_APEX;
    tupleApexX = TUPLE_APEXX;
    defaultApex = DEFAULT_APEX;
    defaultApexX = DEFAULT_APEXX;
    decoratorApex = DECORATOR_APEX;
    decoratorApexX = DECORATOR_APEXX;
    decoratorImplementation = DECORATOR_IMPLEMENTATION;
    decoratorContract = DECORATOR_CONTRACT;
    workflowApex = WORKFLOW_APEX;
    workflowApexX = WORKFLOW_APEXX;
    workflowApexLines = WORKFLOW_APEX.split('\n').length;
    workflowApexXLines = WORKFLOW_APEXX.split('\n').length;
    workflowReduction = Math.round(
        (1 - WORKFLOW_APEXX.split('\n').length / WORKFLOW_APEX.split('\n').length) * 100
    );

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
