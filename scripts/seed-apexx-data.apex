List<Account> existingAccounts = [
    SELECT Id
    FROM Account
    WHERE Name LIKE 'ApexX Demo%'
];

if (!existingAccounts.isEmpty()) {
    delete existingAccounts;
}

List<Account> accounts = new List<Account>{
    new Account(
        Name = 'ApexX Demo - Northern Trail',
        Rating = 'Hot',
        AccountNumber = 'APXX-001',
        AnnualRevenue = 250000
    ),
    new Account(
        Name = 'ApexX Demo - Cloud Kicks',
        Rating = 'Hot',
        AccountNumber = 'APXX-002',
        AnnualRevenue = 250750
    ),
    new Account(
        Name = 'ApexX Demo - Ursa Major',
        Rating = 'Warm',
        AccountNumber = 'APXX-003',
        AnnualRevenue = 98000
    ),
    new Account(
        Name = 'ApexX Demo - No Number Yet',
        Rating = 'Hot',
        AnnualRevenue = 120000
    )
};
insert accounts;

Map<String, Id> accountIdsByName = new Map<String, Id>();
for (Account accountRecord : accounts) {
    accountIdsByName.put(accountRecord.Name, accountRecord.Id);
}

insert new List<Contact>{
    new Contact(
        AccountId = accountIdsByName.get('ApexX Demo - Northern Trail'),
        FirstName = 'Nina',
        LastName = 'North',
        Email = 'nina.north@example.com'
    ),
    new Contact(
        AccountId = accountIdsByName.get('ApexX Demo - Northern Trail'),
        FirstName = 'Theo',
        LastName = 'Trail',
        Email = 'theo.trail@example.com'
    ),
    new Contact(
        AccountId = accountIdsByName.get('ApexX Demo - Cloud Kicks'),
        FirstName = 'Casey',
        LastName = 'Cloud',
        Email = 'casey.cloud@example.com'
    ),
    new Contact(
        AccountId = accountIdsByName.get('ApexX Demo - Ursa Major'),
        FirstName = 'Uma',
        LastName = 'Major',
        Email = 'uma.major@example.com'
    )
};

System.debug('Seeded ApexX demo accounts and contacts.');
