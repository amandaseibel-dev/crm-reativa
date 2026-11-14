# Medições dos bloqueios do gate — produção, 14/11/2026

Consultas (somente leitura): `bloqueios_medicao_20261114.sql` e `bloqueios_acl_e_gestao_20261114.sql`. Conector de banco, papel `postgres`, só `SELECT`.

## Contagens e configuração (`bloqueios_medicao_20261114.sql`)

| Medição | Valor |
|---|---|
| `_tmp_fila2` linhas | **186** |
| `pagamento_suspeita_duplicidade` linhas | **9** |
| `pagamento_suspeita_duplicidade` policies | **0** |
| `vw_pagamento_suspeita_pendente` linhas (visto pelo dono da view) | **9** |
| `vw_extracao_calibragem` linhas | 128 |
| `vw_titulo_presenca_historico` linhas | 0 |
| bucket `tv-imagens` public | **true** |
| objetos em `tv-imagens` | **1** |
| `tv_config.imagens` itens | **0** |

Conteúdo do objeto (PNG de 70.239 bytes, criado em 21/08/2026): conferido por leitura visual da URL pública — tabela institucional de datas de matrícula por unidade, sem dado pessoal, financeiro ou de aluno. Essa conferência é **visual**, não por consulta.

## ACL e função de gestão (`bloqueios_acl_e_gestao_20261114.sql`)

- `_tmp_fila2`: `authenticated` com `arwdDxtm` + `MAINTAIN`; `anon` e `PUBLIC` sem nenhum privilégio; `service_role` com tudo.
- Cinco views: `security_invoker` **off**; `authenticated` com `arwdDxtm` + `MAINTAIN`; `anon` e `PUBLIC` sem nenhum privilégio; `service_role` com tudo.
- `public.usuario_e_gestao()`: `SECURITY DEFINER`, `search_path = public`, lista fixa de três e-mails (`amanda.seibel@`, `cobranca04@`, `cobranca07@`). Definição completa na saída da consulta.

Estas são as concessões que o rollback restaura. `MAINTAIN` aparece porque é o padrão do Postgres 17 para `GRANT ALL`.
