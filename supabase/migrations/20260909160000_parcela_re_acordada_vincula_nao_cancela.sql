-- A PARCELA RE-ACORDADA VINCULA, NAO CANCELA.
--
-- Quando a parcela de um acordo e renegociada, ela vira um titulo
-- (tipo_boleto = 'Acordo', documento = '0' || boleto da parcela) e esse titulo
-- entra num acordo novo. Confere em 382 de 395 casos (96,7%).
-- O CRM nao lia isso: a parcela continuava VENCIDA no acordo velho enquanto a
-- mesma divida ja estava no acordo novo. 278 parcelas, R$ 278.265,02, 230
-- alunos -- cobrados duas vezes.
--
-- POR QUE NAO 'CANCELADA', que seria o caminho obvio:
--   1. Regra da Amanda: nao cancela, sempre vincula. A divida nao some -- ela
--      para de somar e fica na memoria do acordo.
--   2. O gatilho _acordo_fecha_com_a_ultima_parcela marca o acordo como QUITADO
--      quando nao sobra parcela fora de PAGO/CANCELADA. Em 20 acordos nao
--      sobraria nenhuma: R$ 46.415,00 entrariam como "quitado automaticamente:
--      a ultima parcela foi paga" -- recuperacao que ninguem pagou, direto na
--      projecao e no fechamento. Medido antes de aplicar.
-- 'RENEGOCIADA' resolve as duas: sai das somas (que filtram A_VENCER/VENCIDA) e
-- o gatilho nao a confunde com parcela paga.
--
-- ACORDO NOVO CANCELADO FICA DE FORA. Acordo cancelado devolve a divida e o
-- Prime nao reverte -- 1 parcela, R$ 1.060,66, continua sendo cobrada.

create table if not exists public._backup_parcela_re_acordo_20260909 as
select p.id, p.acordo_id, p.numero, p.valor, p.status, p.boleto, p.vencimento, now() as em
  from public.parcelas p where false;

alter table public._backup_parcela_re_acordo_20260909 enable row level security;
drop policy if exists sem_acesso on public._backup_parcela_re_acordo_20260909;
create policy sem_acesso on public._backup_parcela_re_acordo_20260909 for select using (false);

alter table public.parcelas
  add column if not exists renegociada_em timestamptz,
  add column if not exists renegociada_no_acordo_id uuid references public.acordos(id);

comment on column public.parcelas.renegociada_no_acordo_id is
  'Acordo que substituiu esta parcela. Enquanto preenchido, a parcela nao soma: a divida esta no acordo novo. Nao e cancelamento -- a linha continua inteira, com valor e vencimento.';

with alvo as (
  select p.id, nv.id as novo
    from public.parcelas p
    join public.acordos_titulos t on t.documento = '0' || p.boleto
    join public.acordos nv on nv.id = t.acordo_id
   where p.boleto is not null
     and p.status in ('VENCIDA','A_VENCER')
     and nv.status in ('ATIVO','QUITADO')
), guardado as (
  insert into public._backup_parcela_re_acordo_20260909
    (id, acordo_id, numero, valor, status, boleto, vencimento, em)
  select p.id, p.acordo_id, p.numero, p.valor, p.status, p.boleto, p.vencimento, now()
    from public.parcelas p join alvo a on a.id = p.id
  returning id
)
update public.parcelas p
   set status = 'RENEGOCIADA',
       renegociada_em = now(),
       renegociada_no_acordo_id = a.novo,
       atualizado_em = now()
  from alvo a
 where a.id = p.id and p.id in (select id from guardado);

update public.acordos a
   set saldo = coalesce((select sum(p.valor) from public.parcelas p
                          where p.acordo_id = a.id and p.status in ('A_VENCER','VENCIDA')), 0),
       atualizado_em = now()
 where a.id in (select distinct acordo_id from public._backup_parcela_re_acordo_20260909);

do $$
declare v integer;
begin
  select count(*) into v from public.acordos
   where status = 'QUITADO'
     and motivo_ajuste like '%ultima parcela foi paga%'
     and atualizado_em > now() - interval '2 minutes';
  if v > 0 then
    raise exception 'MIGRATION ABORTADA: % acordo(s) foram marcados como quitados por engano.', v;
  end if;
end $$;

insert into public.invariante_config (nome, severidade, titulo, explicacao, base_09_09)
values ('parcela_re_acordada_ainda_cobrando','GRAVE','Parcela renegociada ainda sendo cobrada',
  'A parcela virou titulo e entrou num acordo novo, mas continua VENCIDA ou A_VENCER no acordo antigo -- a mesma divida cobrada duas vezes. Eram 278 (R$ 278.265,02) em 09/09.','278 · R$ 278.265,02 (corrigidas em 09/09)')
on conflict (nome) do update
  set severidade = excluded.severidade, titulo = excluded.titulo, explicacao = excluded.explicacao;
