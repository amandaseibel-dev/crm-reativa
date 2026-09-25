-- =====================================================================
-- ROLLBACK — SOMENTE DO MECANISMO NOVO DE VINCULACAO DE PAGAMENTO
-- Preparado em 12/09/2026. NAO EXECUTADO.
-- Reverte a migration 20260912121224.
--
-- O QUE ESTE ARQUIVO FAZ
--   1. remove os dois gatilhos novos (BEFORE e AFTER INSERT);
--   2. recria o gatilho antigo exatamente como estava antes
--      (definicao copiada da migration 20260831092623);
--   3. nada mais.
--
-- O QUE ESTE ARQUIVO NAO TOCA, DE PROPOSITO
--   * nenhuma linha de public.pagamentos -- nem as 8.999 historicas nem as
--     que o teste criar. Os dois gatilhos novos sao INSERT-only, portanto
--     removê-los nao pode reescrever nada que ja foi gravado;
--   * public.fila_pagamento_sem_vinculo: a TABELA e as linhas ficam. Sao
--     registro de auditoria do teste; apagar seria destruir a evidencia;
--   * parcelas.origem_baixa / origem_baixa_ref / origem_baixa_em: ficam.
--     Vieram de outras duas migrations (20260912121605 e 20260912121649) e
--     nao fazem parte deste mecanismo;
--   * suspeitas_pagamento_duplicado: fica;
--   * nenhuma baixa, nenhum vinculo, nenhum recalculo de saldo.
--
-- CONSEQUENCIA DE EXECUTAR
--   O nome do arquivo volta a poder preencher pagamentos.aluno_id quando for
--   o unico nome parecido na base. Isso e exatamente o risco que a Fase 2B
--   removeu: medido em producao, 54 dos 8.999 pagamentos historicos mudariam
--   de aluno sob a regra nova -- ou seja, sao 54 atribuicoes que o nome fez
--   errado. Executar este rollback reabre essa porta.
--   Use somente se o mecanismo novo estiver causando dano maior que esse.
-- =====================================================================

begin;

-- 1. sai o novo
drop trigger if exists trg_pagamento_vincula_identificador on public.pagamentos;
drop trigger if exists trg_pagamento_enfileira_sem_vinculo on public.pagamentos;

-- 2. volta o antigo, identico ao que a 20260831092623 criou.
--    A funcao _pagamento_vincula_aluno_por_nome_unico() nunca foi removida
--    do banco justamente para este caminho (conferido em 12/09/2026: existe).
create trigger trg_pagamento_vincula_aluno
before insert on public.pagamentos
for each row execute function public._pagamento_vincula_aluno_por_nome_unico();

-- 3. prova, dentro da propria transacao, de que o estado ficou como se espera.
do $$
declare v_novo int; v_antigo int;
begin
  select count(*) into v_novo from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relname = 'pagamentos' and not t.tgisinternal
     and t.tgname in ('trg_pagamento_vincula_identificador','trg_pagamento_enfileira_sem_vinculo');
  select count(*) into v_antigo from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relname = 'pagamentos' and not t.tgisinternal
     and t.tgname = 'trg_pagamento_vincula_aluno';
  if v_novo <> 0 or v_antigo <> 1 then
    raise exception 'rollback nao atingiu o estado esperado: novos=%, antigo=%', v_novo, v_antigo;
  end if;
  raise notice 'rollback do mecanismo de vinculacao: OK. pagamentos NAO foram tocados.';
end $$;

commit;
