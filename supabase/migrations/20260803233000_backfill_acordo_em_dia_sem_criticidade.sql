-- HOTFIX acordo-em-dia-sem-criticidade: alunos com acordo ativo, SOMENTE parcelas
-- futuras (nenhuma vencida em aberto, nenhum titulo vencido nao superado), SEM
-- confirmacao de pagamento pendente, que ainda constavam como CRITICO/URGENTE.
--
-- A regra oficial ja esta implementada em recalcular_situacao_aluno (migrations
-- 20260801120000 + 20260803230000, supersessao). Estes casos eram apenas STALE:
-- nenhum evento financeiro havia disparado o recalculo desde o ultimo backfill.
-- Aqui apenas re-executamos a funcao CANONICA nesses alunos -- idempotente,
-- preserva responsavel, NAO redistribui, NAO gera reposicao, NAO altera
-- pagamentos/parcelas/acordos/baixas. Auto-cura tambem staging.
--
-- Em producao (2026-08-03) foram exatamente 3 alunos (orfaos sem operador);
-- todos passaram a ACORDO_EM_DIA / NORMAL, com 1 retorno automatico cada.

do $$
declare
  r record;
  n int := 0;
begin
  for r in
    with base as (
      select a.id as aluno_id
        from public.alunos a
       where exists (
         select 1 from public.acordos ac
          where ac.aluno_id = a.id
            and upper(coalesce(ac.status,'')) not in ('CANCELADO','CANCELADA','QUITADO','QUITADA')
            and exists (select 1 from public.parcelas p
                         where p.acordo_id = ac.id and coalesce(p.valor,0) > 0))
    )
    select b.aluno_id
      from base b
      join public.alunos al on al.id = b.aluno_id
     where upper(coalesce(al.nivel_criticidade,'')) in ('CRITICO','URGENTE','CRÍTICO')
       -- nenhuma parcela vencida em aberto
       and (select coalesce(sum(p.valor),0)
              from public.parcelas p join public.acordos ac on ac.id = p.acordo_id
             where ac.aluno_id = b.aluno_id
               and upper(coalesce(ac.status,'')) not in ('CANCELADO','CANCELADA')
               and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
               and p.vencimento < current_date) <= 0.005
       -- nenhum titulo vencido nao vinculado e nao superado
       and (select coalesce(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),0)
              from public.acordos_titulos t
             where t.aluno_id = b.aluno_id
               and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
               and coalesce(lower(t.status),'') not in ('quitada')
               and t.vencimento < current_date
               and not exists (select 1 from public.acordo_titulo_vinculo v
                                 join public.acordos a2 on a2.id = v.acordo_id
                                where v.titulo_id = t.id and coalesce(v.ativo,true)
                                  and upper(coalesce(a2.status,'')) not in ('CANCELADO','CANCELADA'))
               and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)) <= 0.005
       -- existe ao menos uma parcela futura em aberto
       and (select coalesce(sum(p.valor),0)
              from public.parcelas p join public.acordos ac on ac.id = p.acordo_id
             where ac.aluno_id = b.aluno_id
               and upper(coalesce(ac.status,'')) not in ('CANCELADO','CANCELADA')
               and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
               and p.vencimento >= current_date) > 0.005
       -- sem confirmacao de pagamento pendente (essa NAO pode virar ACORDO_EM_DIA)
       and (select count(*) from public.solicitacoes_confirmacao_pagamento s
             where s.aluno_id = b.aluno_id::text and s.status = 'AGUARDANDO_CONFIRMACAO') = 0
  loop
    perform public.recalcular_situacao_aluno(r.aluno_id, 'backfill_acordo_em_dia_20260803');
    n := n + 1;
  end loop;
  raise notice 'backfill_acordo_em_dia_20260803: % alunos recalculados', n;
end $$;
