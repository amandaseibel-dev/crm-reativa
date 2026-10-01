-- BACKUP ANTES da correcao das mensalidades presas em acordo cancelado sem
-- pagamento (regra 20260925123852). Nao altera nenhum dado de negocio: so copia
-- as 19 linhas de acordos_titulos, com todas as colunas, para permitir a
-- reversao integral por id. Aborta se a populacao nao for 19 / R$ 8.457,59.
do $$
declare
  v_qtd int;
  v_soma numeric;
begin
  create table public._backup_reabre_mensalidade_acordo_cancelado_20260925 as
    select t.*, now() as salvo_em
      from public.acordos_titulos t
      join public.acordos ac on ac.id = t.acordo_id
     where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
       and upper(coalesce(ac.status,'')) in ('CANCELADO','CANCELADA','QUEBRADO','INATIVO')
       and not exists (
         select 1 from public.acordo_titulo_vinculo v
           join public.acordos a on a.id = v.acordo_id
          where v.titulo_id = t.id and coalesce(v.ativo, true)
            and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
       and not exists (
         select 1
           from (select v.acordo_id from public.acordo_titulo_vinculo v where v.titulo_id = t.id
                 union
                 select t.acordo_id) c
          where c.acordo_id is not null
            and (exists (select 1 from public.parcelas p
                          where p.acordo_id = c.acordo_id and upper(coalesce(p.status,'')) = 'PAGO')
                 or exists (select 1 from public.baixas_pagamento b
                             where b.acordo_id = c.acordo_id and b.devolvido_em is null)));

  select count(*), coalesce(sum(valor_original), 0) into v_qtd, v_soma
    from public._backup_reabre_mensalidade_acordo_cancelado_20260925;
  if v_qtd <> 19 or v_soma <> 8457.59 then
    raise exception 'populacao mudou: % titulos / R$ % (esperado 19 / 8457.59) -- backup nao criado', v_qtd, v_soma;
  end if;

  alter table public._backup_reabre_mensalidade_acordo_cancelado_20260925 add primary key (id);
  alter table public._backup_reabre_mensalidade_acordo_cancelado_20260925 enable row level security;
  revoke all on public._backup_reabre_mensalidade_acordo_cancelado_20260925 from anon, authenticated;
end $$;
