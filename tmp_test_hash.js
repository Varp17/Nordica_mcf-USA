import bcrypt from 'bcryptjs';
const hash = '$2a$10$DC9d6SQpYsVdgmuYFguj9eZ8TpGa4JjGiPM99QvhFcmpof/huHhv9y';
const pass = 'Admin@Secure123!';

bcrypt.compare(pass, hash).then(res => {
    console.log('Match:', res);
});
