# Pacote — tabulação de termo físico restrita à gestão (20261114120000)

**Status: PREPARAÇÃO CONCLUÍDA — IMPLANTAÇÃO BLOQUEADA** por bloqueios externos listados abaixo. Não autoriza execução em produção. Sem linha em `migracoes-aprovadas.tsv`. Linha M1 apenas em rascunho (`docs/seguranca/linha-m1-rascunho-20261114120000.md`), sem validade.

## Decisões registradas (não reabertas)
- **Rollback recusa sempre** (SQLSTATE P0001), sem remover objeto nem dado. Reversão = correção para frente, revisada e autorizada separadamente. **Limitação:** este desenho **não cumpre automaticamente** a exigência de rollback do CHECKLIST; o parecer explícito do Guardião é necessário.
- Gestão: os três e-mails de `usuario_e_gestao()`; sem permissões novas.
- Desfazer do operador com código restrito: recusado inteiro ("Nada foi desfeito").
- Descrição fixa do registro; rótulos aprovados preservados.
- Aba ADM não grava código de registro no estado do aluno (commit `b63a69d6`, preservado).

## Premissa 12 — resolvida no banco
- **Operação** `public.registrar_administrativo_termo_fisico(p_aluno_id, p_codigo)` (na migração `20261114120000`): SECURITY DEFINER, `search_path = public`, EXECUTE só para `authenticated`. Impõe: gestão (`usuario_e_gestao()`), dois códigos, aluno existente, histórico apenas (`REGISTRO_ADMINISTRATIVO`, `registrado_em = now()` do servidor, autor do JWT). Não toca em `alunos`, acionamento, retorno, fidelização, fila nem saldo.
- **Front** (`src/utils/tabulacoes.js`) apenas chama a operação (`rpc`). Não há `insert` direto (teste `tabulacoesRegistroAdministrativo.test.js`).
- **Trigger** `aluno_mov_tabulacao_so_gestao` (INSERT OR UPDATE) mantém a barreira mesmo para gravação direta.

## Barreira de alunos — migração própria (`20261114130000`)
- Recria `_encerramento_so_gestao()` com normalização **consistente** `upper(regexp_replace(valor, '[^A-Za-z0-9_]', '', 'g') COLLATE "C")` no catálogo e nos três status (no lugar de `upper(btrim(...))`, que deixava passar tab, quebra, retorno e caracteres invisíveis).
- **Guarda:** só substitui se o `md5(pg_get_functiondef)` atual for `5ff3be8222f1f33d6a679be8b313fec5` (corpo lido em produção). Sem alteração de dados.
- Testes: `08_barreira_normalizacao.sql` (11 variantes: espaço, tab, LF, CR, ZWSP, BOM, NBSP, U+3000, caixa, sufixo invisível), rodando como `app_teste` (fora do bypass de dono).
- **Verificado localmente:** guarda de md5 passa e a migração aplica sem erro. **Não verificado localmente:** o comportamento da barreira sob papel de LOGIN (só no CI).

## Auth — confirmação e troca de e-mail
**NÃO VERIFICADO.** As ferramentas desta sessão não expõem a configuração de Auth do projeto (confirmação de e-mail obrigatória, troca de e-mail, origem da identidade). Nenhuma conta ou configuração foi alterada. `usuario_e_gestao()` confia no claim `email` do JWT. **Não tratado como vulnerabilidade comprovada.** Bloqueio externo: leitura da configuração de Auth por quem tem acesso ao painel do projeto.

## Artefatos (SHA-256 integral)
| Arquivo | SHA-256 | Bytes |
|---|---|---|
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.pendente` | `d363a6aab3f837b5678725186c1a932cfed00c78615af7a09aecbaa251bfedc8` | 7722 |
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.rollback.sql` | `e224e6f206471775eb4f45126d11d68393434d6e32b1a867aa61ba1b1f46cfaa` | 776 |
| `supabase/aguardando_aprovacao/20261114130000_barreira_alunos_normalizacao.sql.pendente` | `7c178a98e4e8f807c36cd9335072765d8a8acfb5f5cf1efe5d62783ca0f6b7a1` | 6349 |
| `scripts/seguranca/auditoria_seguranca.sql` | `87ed9b7326c6fdbdffd2956c1d3b3f448910ae2e0010f11954418de9c986dd85` | 5682 |
| `docs/seguranca/evidencias/prod_encerramento_so_gestao.sql` | `cae8f5422b93341fb62debd5e524d10182054ffca7a968cf5b749928ecd3aea9` | 5366 |
| `docs/seguranca/evidencias/prod_usuario_e_gestao.sql` | `83191ea84a90cc0e098d8d33da6179a9c7b6ab4a73c23b2113d4007fbabdb288` | 321 |
| `docs/seguranca/evidencias/prod_schema_rls_grants_movimentacoes_tabulacoes.md` | `cc16b9d3fe38b58b86d842a17835faf131e0c383dc98f174a532f1deca2f4491` | 3944 |

Heads: #954 = `aed2ed95db09c12690578e0963f144dc4a9af95f` (este commit). #951 = `ad895092860ef5d24adf6e949371395bc6cbc435`.

Evidências (md5 conferido no banco, só leitura): `usuario_e_gestao()` = `af3d391f4234e6a352585777897568e4`; `_encerramento_so_gestao()` = `5ff3be8222f1f33d6a679be8b313fec5`.

## Gate A — 7 achados BLOQUEIA (abertos, frente responsável)
- `BUCKET_PUBLICO` `tv-imagens` — exceção limitada da TV após revisão do conteúdo público (frente TV). **Não resolvido.**
- `TABELA_SEM_RLS` `_tmp_fila2` — revogação de acesso sem apagar (frente de dados). **Não resolvido.**
- `VIEW_BYPASS_RLS` (5 views): `vw_extracao_calibragem`, `vw_extracao_observabilidade`, `vw_extracao_validacao_trilha`, `vw_pagamento_suspeita_pendente`, `vw_titulo_presenca_historico` — correção com testes dos consumidores (frente de views). **Não resolvido.**
**Não há exceção nem declaração de resolução.** Reexecução do gate depois de tratados.

## Bloqueios externos de implantação (comprovados)
1. Gate A: 7 `BLOQUEIA` abertos (frentes acima).
2. Reconciliação do repositório: `_encerramento_so_gestao()` e `usuario_e_gestao()` versionados como migração (hoje só evidência); divergência com `20261106140000_*.pendente`.
3. Auth: configuração de confirmação e troca de e-mail (não lida).
4. Papel `reativa_responsavel_executor` (INSERT irrestrito): não lido se é usado com `SET ROLE` por cliente.
5. `tabulacoes` sem DDL base versionado.
6. CI verde no head final (ver abaixo) e parecer do Guardião sem `REPROVADO`.
7. Autorização nominal, executor único, janela M1 publicada só na aprovação.

## Sequência de implantação
1. Resolver os bloqueios 1–7.
2. **Banco:** aprovação final → aplicar `20261114120000` → aplicar `20261114130000` (guarda md5) → validação somente leitura.
3. **Frontend (#951):** merge somente após validação do banco.

## Resultados por SHA
- Testes locais (runner reconstruído, sem papel de LOGIN): caminho A e B passam; operação de registro passa; migração da barreira aplica com guarda md5 OK.
- CI e Guardião: ver seção "Resultado" atualizada após a execução.

## Comunicado
Pronto **somente após** publicação e validação. Não é enviado automaticamente.
