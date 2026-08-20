public with sharing class UserFriendlyError implements ApexX.Decorator {
    public Object handle(ApexX.Invocation ctx, ApexX.Next next) {
        try {
            return next.call();
        } catch (AuraHandledException ex) {
            throw ex;
        } catch (Exception ex) {
            throw new LwcUtil().getUserFriendlyException(ex);
        }
    }
}
