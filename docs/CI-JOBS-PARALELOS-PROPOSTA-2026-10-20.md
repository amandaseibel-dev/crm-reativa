# Separar o CI em jobs paralelos — proposta medida

**Data:** 2026-10-20 · **Estado: PROPOSTA. Nada implementado, `ci.yml` intocado
nesta PR.** Pedido da gestão em 20/10/2026: preparar a separação sem implementá-la
até avaliarmos o impacto.

Documento irmão: a PR do teto de 40 minutos (`ci: teto do job verificar de 25 para
40 minutos`), que destrava hoje e não resolve crescimento.

---

## 1. A medição que muda a proposta

A instrução original era "separar os testes de frontend e PostgreSQL em jobs
paralelos". Medi onde o tempo está antes de desenhar, no log do job
`118661906774` (run `39432797275`, o da PR #700 que estourou o teto):

| Grupo | Arquivos | Testes | Tempo somado | % |
|---|---:|---:|---:|---:|
| `supabase/tests/` (PGlite) | 130 | 2.775 | 4.111,4 s | **97,7%** |
| `src/` (front) | 114 | 1.595 | 96,0 s | **2,3%** |
| **total** | **244** | **4.370** | **4.207,4 s** | |

**Consequência: separar front de Postgres não entrega ganho.** O job de front
ficaria com 2,3% do trabalho e o de Postgres com 97,7%. O caminho crítico do run
continua sendo o job de Postgres, praticamente do tamanho do job de hoje.

O ganho real está em **repartir o próprio grupo de Postgres** em vários jobs
paralelos.

> `tempo somado por arquivo` não é a duração do job: o vitest já roda arquivos em
> paralelo. O job levou ~25 min para 4.207 s somados, ou seja o vitest já extrai
> cerca de **2,8× a 3,5×** de paralelismo interno. Os números da seção 3 partem
> disso, e por isso são estimativa, não medição.

## 2. Por que shard funciona aqui

Os testes de banco usam **`@electric-sql/pglite`** — Postgres in-process, não
container. São **CPU-bound e sem estado compartilhado entre arquivos**: cada
arquivo levanta e derruba o seu próprio banco. Não há porta, volume nem serviço a
coordenar, então repartir os arquivos entre runners é seguro por construção.

`vitest` 2.1.9 (`vitest run`) suporta `--shard=i/N` nativamente.

O job `proposta-conferido` é outra coisa e **fica como está**: ele roda um Postgres
de verdade em container, com `timeout-minutes: 10`, e não entra nesta proposta.

## 3. Topologia proposta

Três jobs, com as catracas rodando **exatamente uma vez** cada:

| Job | Nome do check | Conteúdo | Estimativa |
|---|---|---|---|
| `verificar` | `testes, build e catracas` *(nome preservado)* | `npm ci`, testes de `src/`, `build`, `Catraca do lint`, `Catraca das migrations` | ~5 min |
| `testes-banco` | `testes de banco (i/4)` | matriz de 4 shards: `vitest run supabase/tests/ --shard=i/4` | ~8 min |
| `ci-verde` | `ci verde` | job de agregação, só `needs:` — existe para haver **um** check que prova que todos os shards passaram | segundos |

O nome do check `verificar` é preservado de propósito: o monitor do app, os
comentários da Vercel e qualquer coisa que leia nome de check continuam
funcionando.

### Estimativa de impacto

| Cenário | Caminho crítico | Ganho |
|---|---|---|
| hoje (1 job) | 20–25 min | — |
| front × Postgres (proposta original) | 20–24 min | **≈ nenhum** |
| **4 shards de Postgres** | **~8 min** | **~3×** |
| 6 shards | ~6 min | retorno decrescente: o `npm ci` passa a dominar |

**Recomendação: N = 4.** Acima disso o custo fixo de cada shard (checkout +
`npm ci`) come o ganho.

### Esboço, para avaliação — NÃO aplicado

```yaml
  verificar:
    name: testes, build e catracas
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0        # a catraca das migrations compara com o branch base
      - uses: actions/setup-node@v5
        with: { node-version: '22', cache: npm }
      - name: Instalar (a partir do package-lock)
        run: npm ci
      - name: Testes de interface
        run: npx vitest run src/
      - name: Build
        run: npm run build
      - name: Catraca do lint
        run: node scripts/ci/catraca-lint.mjs
      - name: Catraca das migrations
        env:
          CATRACA_BASE: ${{ github.event_name == 'push' && github.event.before || '' }}
        run: npm run check:migrations

  testes-banco:
    name: testes de banco (${{ matrix.shard }}/4)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false          # um shard vermelho não esconde os outros
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v5   # clone raso basta: não roda catraca de migration
      - uses: actions/setup-node@v5
        with: { node-version: '22', cache: npm }
      - run: npm ci
      - name: Testes de banco
        run: npx vitest run supabase/tests/ --shard=${{ matrix.shard }}/4

  ci-verde:
    name: ci verde
    runs-on: ubuntu-latest
    needs: [verificar, testes-banco, proposta-conferido]
    if: always()
    steps:
      - name: Exigir verde em todos
        run: |
          [ "${{ needs.verificar.result }}" = "success" ] || exit 1
          [ "${{ needs.testes-banco.result }}" = "success" ] || exit 1
          [ "${{ needs.proposta-conferido.result }}" = "success" ] || exit 1
```

## 4. Riscos a avaliar antes de implementar

**R1 · `--shard` reparte por arquivo, não por tempo.** Os 130 arquivos de banco são
muito desiguais (de 16 ms a 4 s). O vitest ordena por tamanho de arquivo, que é
proxy fraco para duração. Um shard pode dominar e virar o novo caminho crítico.
*Mitigação:* medir a duração de cada shard no primeiro run e, se a dispersão for
alta, trocar a matriz por listas explícitas de arquivos.

**R2 · Ausência de check lê como verde.** Com matriz, se um shard não roda (erro de
expressão, matriz vazia, `if` mal escrito) o check simplesmente não aparece — e
nada fica vermelho. É exatamente por isso que o job `ci-verde` existe: um único
check que falha quando qualquer dependência não foi `success`. Sem ele, a
obrigatoriedade das catracas fica pior do que é hoje.

**R3 · A `main` não tem branch protection.** `GET /repos/.../branches/main/protection`
responde **404 "Branch not protected"**. Hoje **não existe required status check no
nível do GitHub**; as catracas são obrigatórias por processo. Isso significa que
esta mudança não quebra required check nenhum — e também que, se a `main` for
protegida algum dia, a lista de contexts precisa incluir **`ci verde`**, não os
shards individuais. Proteger a `main` é assunto próprio, fora desta proposta.

**R4 · `npm ci` passa a rodar 5× por run** (1 em `verificar` + 4 shards). O
repositório é público, então o minuto de Actions custa US$ 0,00; o preço é
latência, já amortecida pelo `cache: npm` que o workflow usa.

**R5 · Memória do PGlite.** Cada shard sobe seus próprios workers de vitest.
`ubuntu-latest` tem 4 vCPU. Já houve aperto de memória na máquina local com várias
rodadas simultâneas (ver `scripts/dev/trava-testes.mjs`, PR #664). *Mitigação:*
menos workers por shard e mais shards é mais seguro que o contrário.

**R6 · `fail-fast` precisa ser `false`.** Com o padrão `true`, o primeiro shard
vermelho cancela os outros e o relatório esconde falhas — o oposto do que se quer
num CI de catraca.

## 5. O que esta proposta NÃO faz

- **Não remove, não ignora e não enfraquece teste nenhum.** Os 244 arquivos / 4.370
  testes continuam rodando: 114 em `verificar`, 130 repartidos entre os 4 shards.
  A soma é idêntica à de hoje.
- Não toca regra de negócio.
- Não toca `proposta-conferido`.
- Não altera `vitest.config.js` nem `package.json`.
- **Não aplica nada:** nesta PR o `ci.yml` não foi modificado. O esboço da seção 3
  existe para ser avaliado.

## 6. Critérios de aceite, quando for implementada

1. A soma de testes executados é igual à de hoje — conferida pelo total somado dos
   shards contra o run de referência.
2. Existe **um** check que reprova se qualquer job dependente não for `success`.
3. As duas catracas rodam exatamente uma vez cada, no job com `fetch-depth: 0`.
4. O check `testes, build e catracas` mantém o nome.
5. Nenhum shard passa de 15 min, medido em dois runs.
6. `fail-fast: false` na matriz.
