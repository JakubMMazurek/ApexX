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
        AnnualRevenue = 250000,
        NumberOfEmployees = 18
    ),
    new Account(
        Name = 'ApexX Demo - Cloud Kicks',
        Rating = 'Warm',
        AccountNumber = 'APXX-002',
        AnnualRevenue = 250750,
        NumberOfEmployees = 60
    ),
    new Account(
        Name = 'ApexX Demo - Ursa Major',
        Rating = 'Hot',
        AccountNumber = 'APXX-003',
        AnnualRevenue = 98000,
        NumberOfEmployees = 7
    ),
    new Account(
        Name = 'ApexX Demo - No Number Yet',
        Rating = 'Hot',
        AnnualRevenue = 120000,
        NumberOfEmployees = 20
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
        Email = 'NINA.NORTH@EXAMPLE.COM'
    ),
    new Contact(
        AccountId = accountIdsByName.get('ApexX Demo - Northern Trail'),
        FirstName = 'Theo',
        LastName = 'Trail'
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
        Email = 'UMA.MAJOR@EXAMPLE.COM'
    )
};

System.debug('Seeded ApexX demo accounts and contacts.');
