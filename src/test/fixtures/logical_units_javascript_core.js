import fs from 'fs';

const CONFIG_TIMEOUT = 5000;
const SYSTEM_PROMPT = `You are a helpful assistant...`;
const API_URL = process.env.API_URL || 'http://localhost';

export function exportedHelper(value) {
    return value.trim();
}

const arrowHelper = async (count) => {
    return count + CONFIG_TIMEOUT;
};

class JavaScriptService {
    async load(name) {
        return name;
    }

    render(value) {
        return `${API_URL}/${value}`;
    }
}

const publicHandlers = {
    run(value) {
        return exportedHelper(value);
    }
};

function readSomething(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (error) {
        return 'fallback';
    }
}
