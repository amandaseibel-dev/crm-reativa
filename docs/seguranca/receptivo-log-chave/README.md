# Chave do log receptivo por conversa: evidências locais

Ambiente: PostgreSQL 16.15 (localhost, instância isolada e encerrada depois), cliente psql 16.2.
Dados: ficticios (operadores op_*@test.local, telefones 5551900000000…). Nenhum dado de aluno.

Arquivos:
- `evidencia-suite-local-2026-11-12.log`: suite completa (`supabase/tests/receptivo_log_chave/run_local.sh`):
  - antes: a chave antiga PERDE a segunda conversa no mesmo instante (`PERDA_ANTES` = 1 linha, esperado 2);
  - migration em transação única;
  - 16 casos (C1–C9d), 0 falhas;
  - corrida, duas conexões: mesma conversa/ciclo conta 1; conversas diferentes contam 2;
  - rollback com duplicidade nova é RECUSADO sem apagar nada (linhas preservadas);
  - rollback em banco limpo + conferência R1–R5, 0 falhas.
- `evidencia-cota10-replica-local.log`: réplica do job da cota 10 (commit 49336f66 da #910): 60 asserções, 0 falhas.
- `evidencia-v2-replica-local.log`: réplica do job da v2 (#894): 34 asserções, 0 falhas.

Limitações:
- A pré-condição usa um marcador (`whatsapp_cadencia_sem_limite_individual`) no ambiente de teste; a cota completa é testada na suite dela.
- O log de produção não tem `conversa_id`; o backfill só preenche ciclos que casam com UMA conversa atual. Em produção (195 linhas, 46 WHATSAPP), a estimativa é de poucas linhas recuperáveis; o resto fica NULL, sem invenção.
- Não há job de CI para esta suite ainda; ver PR.
