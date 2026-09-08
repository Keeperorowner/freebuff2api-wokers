import json, pathlib, sys

cred_file = pathlib.Path('freebuff_tools/freebuff_credentials.json')
d = json.load(open(cred_file, encoding='utf-8'))
cred_dir = pathlib.Path('credentials')
cred_dir.mkdir(exist_ok=True)
count = 0
for acc_id, acc in d.get('accounts', {}).items():
    email = acc.get('email', '')
    out = {'email': email, 'authToken': acc.get('authToken', ''), 'name': email}
    p = cred_dir / (acc_id + '.json')
    p.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
    count += 1
    print('written %s -> %s' % (p.name, email))
print('total: %d credentials' % count)