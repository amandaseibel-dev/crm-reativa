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
| objetos em `tv-imagens` | **1** — 70.239 bytes, `image/png`, criado em 21/08/2026 12:37 UTC (saída desta consulta) |
| `tv_config.imagens` itens | **0** |

Conteúdo do objeto: conferido por leitura visual da URL pública — tabela institucional de datas de matrícula por unidade, sem dado pessoal, financeiro ou de aluno. Essa conferência é **visual**, não por consulta.

## ACL e função de gestão

Saída bruta, sem resumo: `bloqueios_acl_e_gestao_20261114_SAIDA.json` (consulta `bloqueios_acl_e_gestao_20261114.sql`, 14/11/2026, conector, só `SELECT`).

- `_tmp_fila2` e as cinco views: `authenticated`, `postgres` e `service_role` com 8 privilégios cada (`DELETE`, `INSERT`, `MAINTAIN`, `REFERENCES`, `SELECT`, `TRIGGER`, `TRUNCATE`, `UPDATE`). Nenhuma linha para `anon` nem para `PUBLIC`.
- `security_invoker` **off** nas cinco views.
- `public.usuario_e_gestao()`: corpo de produção na saída bruta. Comparado com o stub de `supabase/tests/bloqueios_gate_tmp_views.test.js`: **igual**, a menos de espaços em branco e do `;` final.

`MAINTAIN` aparece na ACL medida das views. A documentação do PostgreSQL 17 descreve esse privilégio para tabelas e materialized views; a divergência não foi resolvida pela documentação. Por isso o rollback usa `GRANT ALL`, que reproduz exatamente a ACL medida, qualquer que seja a origem do `MAINTAIN`.
