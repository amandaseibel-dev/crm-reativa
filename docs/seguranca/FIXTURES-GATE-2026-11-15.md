# Fixtures dos dois jobs de TRUNCATE

Escopo: delta de testes sobre `0b224abdb58c2fd0f84c381695afde773366bc6e`, na PR #936.
Nenhuma migration, rollback, regra de fidelizacao ou objeto de producao e alterado.

## Diagnostico e correcoes

* `_teste_tabela_do_baseline` nao era um teste negativo: o comentario e seus
  consumidores apenas guardam/consultam o nome do backup. O `CREATE TABLE AS`
  herdava grants sem ligar RLS. A auxiliar agora tem RLS deny-all e nenhum
  privilegio dos quatro papeis da aplicacao. A causa raiz dos backups, os
  default privileges, permanece reproduzida e testada.
* `acordos_titulos` era uma origem simplificada sem RLS. O contrato de seguranca
  exige RLS em tabela operacional (premissa de seguranca, §3); as policies de
  escrita estao em `20260726201500_restringir_escrita_cruzada_operacional.sql`.
  O fixture agora liga RLS, preserva o grant herdado inclusive TRUNCATE, e
  exige leitura vazia e INSERT recusado com SQLSTATE 42501 como authenticated.
  A RPC continua copiando as duas linhas como dono, com SECURITY DEFINER.
  Nao foi criada policy permissiva para satisfazer o gate.
* O negativo deliberado passou a ser separado: `_teste_gate_sem_rls_negativo`,
  sem RLS e com SELECT para authenticated. O runner exige exit 1 e exatamente
  a linha abaixo, sem aceitar falha SQL, erro de conexao ou outro BLOQUEIA:

```text
BLOQUEIA<TAB>TABELA_SEM_RLS<TAB>_teste_gate_sem_rls_negativo<TAB>Tabela em public com RLS desligada
```

O runner roda o gate real antes do negativo, remove a tabela negativa e exige
aprovacao novamente. Ambos os jobs chamam esse runner. Exige opt-in explicito,
URL local e banco `teste`; nao e um script de producao.

## Provas locais

PostgreSQL 17.6 descartavel, UTF8, porta local 55432, bancos novos para cada job.
Os comandos foram extraidos dos dois jobs do workflow; so a porta/host locais
foram substituidos. As duas execucoes completas terminaram com exit 0:

| Job | Prova |
| --- | --- |
| `revoke-truncate-backup-pos-import` | 8 casos, rollback, baseline valido, negativo exato, baseline restaurado |
| `acordos-pos-importacao-sem-truncate` | 7 casos, recusa da segunda aplicacao, rollback, baseline valido, negativo exato, baseline restaurado |

Os ALERTA continuam na saida. Nao foram filtrados nem reclassificados.

## Integridade e limites

Auditoria e gate nao mudam neste delta. SHA-256 preservados:

| Arquivo | SHA-256 |
| --- | --- |
| `scripts/seguranca/auditoria_seguranca.sql` | `158ed515b431444135476d09d7414aeeb6b7fc6117bb2ea33dd2a33e2f6c7c34` |
| `scripts/seguranca/run_security_gate.sh` | `ed1290a5b88f83c266ae5325986db4eac1184b2cfc3b423d0048372557b96f67` |

A correcao do ORDER BY sobre subconsulta ja existe e permanece intacta.
Nao ha excecao ou lista de objetos ignorados na auditoria.

Esta bancada simplifica colunas e nao reproduz todas as policies de
`acordos_titulos`, helpers, perfis, dados ou ambiente Supabase. Prova o contrato
do fixture e as transicoes do gate, nao a equivalencia completa com producao.
O gate de producao e os demais bloqueios da #936 continuam independentes.
CI e Guardiao devem identificar o mesmo head deste delta; os resultados locais
nao substituem nenhum deles e nao autorizam aplicar a #936 ou a #953.

Reversao do delta: reverter somente este commit de testes. Nao executar SQL em
producao. Nenhuma janela M1 ou autorizacao e criada por este documento.
