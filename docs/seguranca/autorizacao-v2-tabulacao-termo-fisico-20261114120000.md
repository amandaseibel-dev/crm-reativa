# Autorização v2 — tabulação de termo físico (20261114120000) — PENDENTE DE APROVAÇÃO

**Status: PENDENTE DE APROVAÇÃO. Nenhuma aprovação foi registrada. Não autoriza execução de migration, rollback, SQL em produção, merge ou publicação de M1.**

## Relação com a autorização anterior

- A autorização anterior, `docs/seguranca/autorizacao-tabulacao-termo-fisico-20261114120000.md`, **não foi reescrita**. Ela está no conteúdo do head `1ac94a6f`, em que ainda constava o SHA-256 `d4f41e313a08f64cc6b746072f13d9a65bc8a62e3ea976248277165f1409bdc4` (5000 bytes) para o rollback.
- Esta v2 **substituiria** a anterior somente se for aprovada. Até lá, a anterior segue como registro histórico.
- Divergências que esta v2 registra (sem reescrever a anterior):
  - o rollback declarado na anterior (`d4f41e31…`, 5000 bytes, commit `be990338`) não é o rollback presente no head;
  - o rollback atual (`96871b2e…`, 6215 bytes, commit `c0d217d1`) é mais restritivo;
  - a anterior listava os artefatos de teste de contenção sem SHA-256;
  - a menção à contenção `20261114140000` na anterior foi resolvida pela separação (ver abaixo).
- **Correções e atualizações registradas nesta v2 (a anterior não é reescrita):**
  - Hash da auditoria: a anterior cita `scripts/seguranca/auditoria_seguranca.sql` com SHA-256 `87ed9b7326c6fdbdffd2956c1d3b3f448910ae2e0010f11954418de9c986dd85` (5682 bytes). O arquivo atual, idêntico ao `origin/main` e não alterado por esta #954, tem `d2a4c33179e9b0a05f63b33469bcbdd3a35c5e108dc587845bce9ac8f7ab0c67` (5629 bytes). A correção é de registro; o pacote não altera o arquivo.
  - Texto de cobertura do CI: a anterior fala em "recusas" sem detalhar. Esta v2 lista as quatro recusas do `recusas_rollback.sh` (aluno, catálogo, contenção ativa, contenção alterada por outro autor).
  - Preparações de teste da contenção (`11p_*`, `12p_on`, `12p_off`): usam atualização direta da flag, com o mesmo efeito sobre `contencao_ativa`, e não a migration B1 nem a sua pré-condição/transação.
  - Evidências novas que a anterior não listava: `recusas_rollback.sh`, `fingerprint_dados_termo.sql`, `snapshot_termo_fisico.sql`, `12n_contencao_flag_fixture.sql`.

## Escopo final

- **Entrega:** migration `20261114120000` (tabulação de termo físico restrita à gestão, barreira de histórico, RPC de registro e tabela de contenção, cuja flag começa `false`).
- **Fora do escopo, separada e não aplicada:** migration `20261114140000` (ativação da contenção, B1). Preservada no branch local `proposta/contencao-termo-20261114140000` (commit `427300d7`, arquivos em `supabase/aguardando_aprovacao/20261114140000_*` e `supabase/tests/tabulacao_termo_fisico_gestao/12p_reaplica.sql`). Não é dependência da entrega (ver seção de dependência).
- **Fora do escopo:** trava `20261106140000` (branch `wip/trava-so-gestao-20261106140000`), e `20261114130000` (retirada do recorte, inexistente no repositório).

## Artefatos (SHA-256 completo e tamanho em bytes, no head desta proposta)

| Arquivo | SHA-256 | Bytes | Situação |
|---|---|---|---|
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.pendente` | `1c81eb7155009f9a8e68cd22404a526c647c83018d58e87bac5eb3f1fe2c2589` | 10313 | igual ao autorizado |
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.rollback.sql` | `96871b2e876b4a89de5ed6e1661d6ba7484e1ab36148e9b6fd8b5ad002dd75a0` | 6215 | **diferente do autorizado** (`d4f41e31…`, 5000) |
| `supabase/tests/tabulacao_termo_fisico_gestao/recusas_rollback.sh` | `71387c35c0412b9981622587b6313b35d412955cbdf79a4f98ad145d54123fe8` | 3124 | evidência (novo) |
| `supabase/tests/tabulacao_termo_fisico_gestao/fingerprint_dados_termo.sql` | `dd17f9124eb4310d17fd011543e4414f4dcd7aa331fd7c749512ccc375dd411b` | 1267 | evidência (novo) |
| `supabase/tests/tabulacao_termo_fisico_gestao/snapshot_termo_fisico.sql` | `7181ce340942ee18c2035c54af6d2b242139a25a0fe34b30024ea8d1ce6f129b` | 1973 | evidência |
| `supabase/tests/tabulacao_termo_fisico_gestao/12n_contencao_flag_fixture.sql` | `848891fb90c68888be72e08e15e308cc7683a2c21daf3a6b6d096a6ad363aff8` | 1719 | evidência (novo) |

Hashes calculados com `shasum -a 256` no head final. Qualquer alteração posterior invalida esta tabela.

## Rollback: autorizado × proposto

| | Autorizado (anterior) | Proposto (esta v2) |
|---|---|---|
| Commit | `be990338` | `c0d217d1` (conteúdo mantido nos heads seguintes) |
| SHA-256 | `d4f41e313a08f64cc6b746072f13d9a65bc8a62e3ea976248277165f1409bdc4` | `96871b2e876b4a89de5ed6e1661d6ba7484e1ab36148e9b6fd8b5ad002dd75a0` |
| Bytes | 5000 | 6215 |

### Diferenças funcionais

1. **Catálogo (comportamento, mais restritivo):** a versão autorizada conferia código, `criado_por`, `criado_em` e datas. A proposta confere o conteúdo exato gravado pela migração (rótulo, ordem, `ativa`, `somente_gestao`, grupo, retorno, bloco, flags, e-mail de redirecionamento, `atualizado_por` e `desativada_por`). **Motivo:** sem isso, o rollback apagaria uma linha de catálogo editada pela gestão sem recusa. **Efeito:** mais recusas; nenhuma remoção de dado editado.
2. **Mensagem da recusa de contenção (texto):** "contenção foi alterada por outro autor (alterado_por diferente da migração)". A verificação é a mesma.
3. **Comentários do cabeçalho (texto):** explicam a detecção de alteração da contenção por `alterado_por`, e que o snapshot do CI cobre ACL e RLS.

**Sem diferença:** ordem (todas as recusas antes de qualquer `DROP`), `begin`/`commit`, GRANT/REVOKE/POLICY (nenhum), objetos removidos no caminho de sucesso.

### Efeito sobre dados, recusas, permissões e recuperação

- **Dados:** nenhuma recusa altera dados ou objetos. Comprovado por impressão antes e depois de cada tentativa (ver evidências).
- **Recusas:** histórico de termo; aluno no estado de termo; catálogo fora do conteúdo exato; contenção ativa; contenção alterada por outro autor.
- **Permissões:** nenhum GRANT, REVOKE ou POLICY no rollback.
- **Recuperação:** rollback recusado deixa tudo como está. Reversão exige decisão da gestão.

## Dependência da B1 (contenção `20261114140000`)

- A entrega **não depende** da B1 para funcionar com segurança: a `20261114120000` cria a flag com `contencao_ativa = false` (registros abertos) e o gatilho e a RPC leem a flag sem a B1.
- Se a B1 for aplicada e revertida, `alterado_por` fica `reversao_b1` e o rollback da `20261114120000` é **recusado** até decisão da gestão. Isso foi comprovado em bancada (PGlite, papel `postgres`, que não prova o gatilho; ver evidências). Portanto, a B1 **não pode ser aplicada junto** sem decisão específica.
- Os testes de contenção do CI ligam e desligam a flag por fixture (`fixture_teste` / `migration_termo_fisico`), não pela migração B1.

## Evidências a apresentar com esta proposta

1. **CI do head final, job `tabulação termo físico`** (rodado no GitHub Actions, PostgreSQL 17 do job, papéis `app_teste` LOGIN e `app_teste_inh` LOGIN com herança, criados pelo job). Inclui: registro autorizado pela gestão (`07_registro_administrativo.sql`); recusa a operador (`02_tabulacao.sql`, `09_login_nao_privilegiado.sql`, `10_login_inherit_defensivo.sql`); barreira de alunos com login não privilegiado (`05_barreira_alunos.sql`); PostgREST 16.5 real com JWT (operador recusado, gestão aceita, claims forjadas recusadas); rollback recusado por histórico (`03`); rollback limpo com igualdade de snapshot antes e depois (`Caminho B`, `04_rollback_limpo.sql`); recusas por aluno, catálogo, contenção ativa e contenção alterada (`recusas_rollback.sh`) com impressão idêntica antes e depois; flag NOT NULL e ligar/desligar por fixture idempotente (`12n_contencao_flag_fixture.sql`).
2. **Ambiente de teste (CI):** `dono_teste` é NOLOGIN com `bypassrls`, criado apenas para simular o dono das funções; nenhum papel de teste existe em produção.
3. **Produção:** dono das funções `postgres` (rolsuper=false, rolbypassrls=true, medido em leitura); clientes `anon`, `authenticated`, `service_role` do PostgREST. Nenhuma alteração de privilégio neste pacote.
4. **Bancada PGlite (não substitui o CI):** executa como `postgres`, que o gatilho ignora. Usada só para validar a lógica das recusas e a sensibilidade da impressão digital (ela muda com cada ajuste e fica igual antes e depois de cada recusa).
5. **Guardião:** parecer sobre o head final, em texto, sem usar resultados de commits anteriores.

## Não aprovado

- Não há aprovação em nome de nenhuma pessoa. Esta proposta fica pendente até decisão explícita da gestão.
- Não autoriza aplicar `20261114140000` nem reverter `20261114120000`.
