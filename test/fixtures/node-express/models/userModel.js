const users = [
    { id: 1, name: 'Grace Hopper', email: 'grace@example.com' }
];

function createUserRecord(payload) {
    return {
        name: payload.name,
        email: payload.email
    };
}

module.exports = { createUserRecord, users };

