const { createUserRecord, users } = require('../models/userModel');

function findUser(id) {
    return users.find(user => user.id === Number(id)) || null;
}

exports.getAllUsers = (_req, res) => {
    res.json(users);
};

exports.getUserById = (req, res) => {
    const user = findUser(req.params.id);
    if (!user) {
        res.status(404).json({ message: 'User not found' });
        return;
    }
    res.json(user);
};

exports.createUser = (req, res) => {
    const newUser = {
        id: users.length + 1,
        ...createUserRecord(req.body)
    };
    users.push(newUser);
    res.status(201).json(newUser);
};
