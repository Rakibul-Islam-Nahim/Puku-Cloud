# pukucloud CLI

Stdlib-only Go CLI for PukuCloud microVM sandboxes.

## Configuration

```sh
export PUKUCLOUD_API=https://api.pukucloud.ai
export PUKUCLOUD_API_KEY=pds_...   # PUKUCLOUD_TOKEN is still accepted
```

Or log in once and let the CLI save `~/.config/pukucloud/config.json`:

```sh
pukucloud auth login
pukucloud auth whoami
pukucloud auth logout
```

Use `-o json` with list/get-style commands:

```sh
pukucloud -o json sandbox list
pukucloud -o json sandbox get sb_123
pukucloud -o json template list
pukucloud -o json version
```

## Auth

```sh
pukucloud auth login
pukucloud auth whoami
pukucloud auth logout
```

`auth login` prompts for email/password, signs in with Supabase, exchanges the session JWT for a long-lived PukuCloud account token, and saves it locally. Supabase can be overridden with `PUKUCLOUD_SUPABASE_URL` and `PUKUCLOUD_SUPABASE_ANON_KEY`.

## Templates

```sh
pukucloud template list
pukucloud template build -f Dockerfile -n python --size-mb 2048 --context .
pukucloud template delete python
```

`template build` uses Docker to build an image, export a rootfs tar, upload it to `/v1/templates/build`, and poll until the build finishes.

## Sandboxes

```sh
pukucloud sandbox create --template python --ttl 1h
pukucloud sandbox list
pukucloud sandbox get sb_123
pukucloud sandbox delete sb_123
```

Lifecycle helpers:

```sh
pukucloud sandbox pause sb_123
pukucloud sandbox resume sb_123
pukucloud sandbox snapshot sb_123
```

Run commands:

```sh
pukucloud sandbox exec sb_123 -- uname -a
pukucloud sandbox exec sb_123 --timeout 30 -- python -c 'print("hello")'
```

Stream logs:

```sh
pukucloud sandbox logs sb_123
pukucloud sandbox logs sb_123 --no-follow
pukucloud sandbox logs sb_123 --stream stdout
pukucloud sandbox logs sb_123 --stream stderr
```

Copy files:

```sh
pukucloud sandbox cp ./app.py sb_123:/root/app.py
pukucloud sandbox cp sb_123:/root/output.txt ./output.txt
pukucloud sandbox cp sb_123:/root/output.txt .
```

SSH from a network that can route to the guest IP:

```sh
pukucloud sandbox ssh sb_123
```

If the guest IP is private to the PukuCloud cluster, use `pukucloud sandbox exec` instead or run SSH on-cluster.

## Version and help

```sh
pukucloud version
pukucloud help
```

`version` prints both client and server versions and warns when their major.minor versions differ.
