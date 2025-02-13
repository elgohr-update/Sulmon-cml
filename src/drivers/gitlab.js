const fetch = require('node-fetch');
const FormData = require('form-data');
const { URL, URLSearchParams } = require('url');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fse = require('fs-extra');
const { resolve } = require('path');

const { fetch_upload_data, download, exec } = require('../utils');

const { IN_DOCKER, GITLAB_USER_EMAIL, GITLAB_USER_NAME } = process.env;
const API_VER = 'v4';
class Gitlab {
  constructor(opts = {}) {
    const { repo, token } = opts;

    if (!token) throw new Error('token not found');
    if (!repo) throw new Error('repo not found');

    this.token = token;
    this.repo = repo;
  }

  async project_path() {
    const repo_base = await this.repo_base();
    const project_path = encodeURIComponent(
      this.repo.replace(repo_base, '').substr(1)
    );

    return project_path;
  }

  async repo_base() {
    if (this._detected_base) return this._detected_base;

    const { origin, pathname } = new URL(this.repo);
    const possible_bases = await Promise.all(
      pathname
        .split('/')
        .filter(Boolean)
        .map(async (_, index, array) => {
          const components = [origin, ...array.slice(0, index)];
          const path = components.join('/');
          try {
            if (
              (await this.request({ url: `${path}/api/${API_VER}/version` }))
                .version
            )
              return path;
          } catch (error) {}
        })
    );

    this._detected_base = possible_bases.find(Boolean);
    if (!this._detected_base) throw new Error('GitLab API not found');

    return this._detected_base;
  }

  async comment_create(opts = {}) {
    const { commit_sha, report } = opts;

    const project_path = await this.project_path();
    const endpoint = `/projects/${project_path}/repository/commits/${commit_sha}/comments`;
    const body = new URLSearchParams();
    body.append('note', report);

    const output = await this.request({ endpoint, method: 'POST', body });

    return output;
  }

  async check_create() {
    throw new Error('Gitlab does not support check!');
  }

  async upload(opts = {}) {
    const { repo } = this;

    const project_path = await this.project_path();
    const endpoint = `/projects/${project_path}/uploads`;
    const { size, mime, data } = await fetch_upload_data(opts);
    const body = new FormData();
    body.append('file', data);

    const { url } = await this.request({ endpoint, method: 'POST', body });

    return { uri: `${repo}${url}`, mime, size };
  }

  async runner_token() {
    const project_path = await this.project_path();
    const endpoint = `/projects/${project_path}`;

    const { runners_token } = await this.request({ endpoint });

    return runners_token;
  }

  async register_runner(opts = {}) {
    const { tags, name } = opts;

    const token = await this.runner_token();
    const endpoint = `/runners`;
    const body = new URLSearchParams();
    body.append('description', name);
    body.append('tag_list', tags);
    body.append('token', token);
    body.append('locked', 'true');
    body.append('run_untagged', 'true');
    body.append('access_level', 'not_protected');

    return await this.request({ endpoint, method: 'POST', body });
  }

  async unregister_runner(opts = {}) {
    const { name } = opts;

    const { id } = await this.runner_by_name({ name });
    const endpoint = `/runners/${id}`;

    return await this.request({ endpoint, method: 'DELETE', raw: true });
  }

  async start_runner(opts) {
    const { workdir, idle_timeout, single, labels, name } = opts;

    let gpu = true;
    try {
      await exec('nvidia-smi');
    } catch (err) {
      gpu = false;
    }

    try {
      const bin = resolve(workdir, 'gitlab-runner');
      if (!(await fse.pathExists(bin))) {
        const url =
          'https://gitlab-runner-downloads.s3.amazonaws.com/latest/binaries/gitlab-runner-linux-amd64';
        await download({ url, path: bin });
        await fs.chmod(bin, '777');
      }

      const { protocol, host } = new URL(this.repo);
      const { token } = await this.register_runner({ tags: labels, name });
      const command = `${bin} --log-format="json" run-single \
        --builds-dir "${workdir}" \
        --cache-dir "${workdir}" \
        --url "${protocol}//${host}" \
        --name "${name}" \
        --token "${token}" \
        --wait-timeout ${idle_timeout} \
        --executor "${IN_DOCKER ? 'shell' : 'docker'}" \
        --docker-image "dvcorg/cml:latest" \
        --docker-runtime "${gpu ? 'nvidia' : ''}" \
        ${single ? '--max-builds 1' : ''}`;

      return spawn(command, { shell: true });
    } catch (err) {
      throw new Error(`Failed preparing Gitlab runner: ${err.message}`);
    }
  }

  async runner_by_name(opts = {}) {
    const { name } = opts;

    const endpoint = `/runners?per_page=100`;
    const runners = await this.request({ endpoint, method: 'GET' });
    const runner = runners.filter(
      (runner) => runner.name === name || runner.description === name
    )[0];

    if (runner) return { id: runner.id, name: runner.name };
  }

  async runners_by_labels(opts = {}) {
    const { labels } = opts;
    const endpoint = `/runners?per_page=100?tag_list=${labels}`;
    const runners = await this.request({ endpoint, method: 'GET' });
    return runners.map((runner) => ({ id: runner.id, name: runner.name }));
  }

  async pr_create(opts = {}) {
    const { project_path } = this;
    const { source, target, title, description } = opts;

    const endpoint = `/projects/${project_path}/merge_requests`;
    const body = new URLSearchParams();
    body.append('source_branch', source);
    body.append('target_branch', target);
    body.append('title', title);
    body.append('description', description);

    const { web_url } = await this.request({ endpoint, method: 'POST', body });

    return web_url;
  }

  async prs(opts = {}) {
    const { project_path } = this;
    const { state = 'opened' } = opts;

    const endpoint = `/projects/${project_path}/merge_requests?state=${state}`;
    const prs = await this.request({ endpoint, method: 'GET' });

    return prs.map((pr) => {
      const { web_url: url, source_branch: source, target_branch: target } = pr;
      return {
        url,
        source,
        target
      };
    });
  }

  async request(opts = {}) {
    const { token } = this;
    const { endpoint, method = 'GET', body, raw } = opts;
    let { url } = opts;

    if (endpoint) {
      url = `${await this.repo_base()}/api/${API_VER}${endpoint}`;
    }
    if (!url) throw new Error('Gitlab API endpoint not found');

    const headers = { 'PRIVATE-TOKEN': token, Accept: 'application/json' };
    const response = await fetch(url, { method, headers, body });

    if (response.status > 300) throw new Error(response.statusText);
    if (raw) return response;

    return await response.json();
  }

  get user_email() {
    return GITLAB_USER_EMAIL;
  }

  get user_name() {
    return GITLAB_USER_NAME;
  }
}

module.exports = Gitlab;
