-- ALERTA D-2 POR ACORDO + PARCELA (Bloco 3)
--
-- Fonte oficial do preventivo "parcela de acordo proxima do vencimento". Um alerta por (acordo, parcela): um acordo nunca esconde outro;
-- acordo VENCIDO nao gera D-2 para si (ja esta na cobranca), mas outro acordo em dia do mesmo aluno gera. Classificacao SO por parcelas
-- (nunca acordos.saldo). Parametro calibragem_parametros 'alerta_parcela_d2' = {"dias":2,"modo":"CORRIDO"}: D-2 = vencimento - 2 dias
-- corridos (ex.: 19/10 => 17/10), sem dia util. Geracao idempotente (UNIQUE parcial); resolucao por trigger (PAGA / ACORDO_QUITADO /
-- ACORDO_CANCELADO / SUBSTITUIDA) e por varredura (VENCIDA). NUNCA escreve em alunos, casos, parcelas, acordos, agenda ou fidelizacao,
-- nunca entra em Acoes Massivas, cobranca ou redistribuicao. NAO cria cron/job: agendamento diario sugerido (06:15) so documentado.
-- NAO altera recalcular_situacao_aluno nem retorno_acordo_auto (o retorno antigo segue para outros usos).
begin;

create table if not exists public.acordo_alertas_parcela (
  id                uuid primary key default gen_random_uuid(),
  acordo_id         uuid not null references public.acordos(id)  on delete cascade,
  parcela_id        uuid not null references public.parcelas(id) on delete cascade,
  aluno_id          uuid not null,
  tipo              text not null default 'D2' check (tipo in ('D2')),
  numero_parcela    int,
  vencimento        date not null,
  valor             numeric(14,2) not null,
  data_alerta       date not null,
  responsavel_email text,
  criado_em         timestamptz not null default now(),
  resolvido_em      timestamptz,
  resolucao         text check (resolucao in ('PAGA','ACORDO_QUITADO','ACORDO_CANCELADO','VENCIDA','SUBSTITUIDA')),
  constraint acordo_alertas_resolucao_coerente check ((resolvido_em is null) = (resolucao is null))
);
create unique index if not exists acordo_alertas_parcela_aberto_uq on public.acordo_alertas_parcela (acordo_id, parcela_id, tipo) where resolvido_em is null;
create index if not exists acordo_alertas_parcela_resp_idx on public.acordo_alertas_parcela (lower(responsavel_email)) where resolvido_em is null;
alter table public.acordo_alertas_parcela enable row level security;
revoke all on table public.acordo_alertas_parcela from public, anon, authenticated;
grant select on table public.acordo_alertas_parcela to authenticated;
grant select, insert, update, delete on table public.acordo_alertas_parcela to service_role;
drop policy if exists aap_le on public.acordo_alertas_parcela;
create policy aap_le on public.acordo_alertas_parcela for select to authenticated
  using (public.usuario_e_gestao() or lower(coalesce(responsavel_email,'')) = lower(coalesce(auth.jwt()->>'email','')));

-- 1) Classificacao POR ACORDO, so por parcelas (nunca acordos.saldo).
CREATE OR REPLACE FUNCTION public.acordo_classificar(p_acordo_id uuid, p_hoje date DEFAULT current_date)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare a record; v_abertas int; v_venc int; v_total int; v_prox record; v_classe text;
begin
  select * into a from public.acordos where id = p_acordo_id;
  if not found then return jsonb_build_object('classe','inexistente'); end if;
  select count(*), count(*) filter (where p.vencimento < p_hoje) into v_abertas, v_venc
    from public.parcelas p where p.acordo_id = p_acordo_id
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');
  select count(*) into v_total from public.parcelas where acordo_id = p_acordo_id;
  select p.id, p.vencimento, p.valor, p.numero into v_prox from public.parcelas p
   where p.acordo_id = p_acordo_id and p.vencimento >= p_hoje
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
   order by p.vencimento, p.numero limit 1;
  v_classe := case
    when upper(coalesce(a.status,'')) in ('CANCELADO','CANCELADA') then 'cancelado'
    when upper(coalesce(a.status,'')) = 'QUITADO' then 'quitado'
    when v_total = 0 then 'sem_parcela'
    when v_abertas = 0 then 'sem_parcela_aberta'
    when v_venc > 0 then 'vencido'
    else 'em_dia' end;
  return jsonb_build_object('classe', v_classe, 'parcelas_abertas', v_abertas, 'parcelas_vencidas', v_venc,
    'proxima_parcela_id', v_prox.id, 'proxima_vencimento', v_prox.vencimento, 'proxima_valor', v_prox.valor, 'proxima_numero', v_prox.numero);
end;
$function$;

-- 2) Data do alerta (parametrizada): modo CORRIDO = venc - dias; UTIL = dia util anterior ou igual (regra atual de recalcular_situacao_aluno).
CREATE OR REPLACE FUNCTION public.acordo_alerta_data(p_venc date, p_dias int, p_modo text)
 RETURNS date LANGUAGE sql IMMUTABLE AS $f$
  select case when upper(p_modo) = 'UTIL' then public.dia_util_anterior_ou_igual(p_venc - p_dias) else p_venc - p_dias end $f$;

-- 3) Resolucao (varredura + reuso pelos triggers). Nunca toca parcela/acordo.
CREATE OR REPLACE FUNCTION public.acordo_alertas_resolver(p_hoje date DEFAULT current_date)
 RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare n int;
begin
  update public.acordo_alertas_parcela x set resolvido_em = now(), resolucao = q.res
    from (
      select x2.id, case
               when upper(coalesce(a.status,'')) = 'QUITADO' then 'ACORDO_QUITADO'
               when upper(coalesce(a.status,'')) in ('CANCELADO','CANCELADA') then 'ACORDO_CANCELADO'
               when upper(coalesce(p.status,'')) = 'PAGO' then 'PAGA'
               when upper(coalesce(p.status,'')) in ('CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') then 'SUBSTITUIDA'
               when p.vencimento < p_hoje then 'VENCIDA' end res
        from public.acordo_alertas_parcela x2
        join public.acordos a on a.id = x2.acordo_id join public.parcelas p on p.id = x2.parcela_id
       where x2.resolvido_em is null) q
   where x.id = q.id and q.res is not null;
  get diagnostics n = row_count; return n;
end;
$function$;

-- 4) Geracao idempotente. p_hoje/p_dias/p_modo permitem simular datas e a decisao da gestao (dias corridos x util; 2 x 3).
CREATE OR REPLACE FUNCTION public.acordo_alertas_gerar(p_hoje date DEFAULT current_date, p_dias int DEFAULT NULL, p_modo text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_cfg jsonb; v_dias int; v_modo text; v_res int; v_novos int;
begin
  v_cfg  := coalesce((select valor from public.calibragem_parametros where chave = 'alerta_parcela_d2'), '{}'::jsonb);
  v_dias := coalesce(p_dias, nullif(v_cfg->>'dias','')::int, 2);
  v_modo := upper(coalesce(p_modo, nullif(v_cfg->>'modo',''), 'CORRIDO'));
  v_res  := public.acordo_alertas_resolver(p_hoje);
  insert into public.acordo_alertas_parcela (acordo_id, parcela_id, aluno_id, tipo, numero_parcela, vencimento, valor, data_alerta, responsavel_email)
  select a.id, p.id, a.aluno_id, 'D2', p.numero, p.vencimento, p.valor, public.acordo_alerta_data(p.vencimento, v_dias, v_modo),
         coalesce(nullif(btrim(a.operador_responsavel_email),''), nullif(btrim(al.responsavel_atual_email),''))
    from public.acordos a
    join public.parcelas p on p.acordo_id = a.id
    left join public.alunos al on al.id = a.aluno_id
   where upper(coalesce(a.status,'')) = 'ATIVO'
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
     and p.vencimento >= p_hoje
     and p_hoje >= public.acordo_alerta_data(p.vencimento, v_dias, v_modo)
     and public.acordo_classificar(a.id, p_hoje)->>'classe' = 'em_dia'      -- acordo com parcela vencida ja esta na cobranca normal: sem D2
  on conflict (acordo_id, parcela_id, tipo) where resolvido_em is null do nothing;
  get diagnostics v_novos = row_count;
  return jsonb_build_object('hoje', p_hoje, 'dias', v_dias, 'modo', v_modo, 'resolvidos', v_res, 'criados', v_novos);
end;
$function$;

-- 5) Triggers de resolucao imediata (so escrevem na tabela de alertas).
CREATE OR REPLACE FUNCTION public.tg_acordo_alerta_resolve_parcela() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  update public.acordo_alertas_parcela set resolvido_em = now(),
         resolucao = case when upper(coalesce(new.status,'')) = 'PAGO' then 'PAGA' else 'SUBSTITUIDA' end
   where parcela_id = new.id and resolvido_em is null;
  return null;
end; $function$;
CREATE OR REPLACE FUNCTION public.tg_acordo_alerta_resolve_acordo() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  update public.acordo_alertas_parcela set resolvido_em = now(),
         resolucao = case when upper(coalesce(new.status,'')) = 'QUITADO' then 'ACORDO_QUITADO' else 'ACORDO_CANCELADO' end
   where acordo_id = new.id and resolvido_em is null;
  return null;
end; $function$;
drop trigger if exists trg_acordo_alerta_resolve_parcela on public.parcelas;
create trigger trg_acordo_alerta_resolve_parcela after update of status on public.parcelas for each row
  when (upper(coalesce(new.status,'')) in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') and new.status is distinct from old.status)
  execute function public.tg_acordo_alerta_resolve_parcela();
drop trigger if exists trg_acordo_alerta_resolve_acordo on public.acordos;
create trigger trg_acordo_alerta_resolve_acordo after update of status on public.acordos for each row
  when (upper(coalesce(new.status,'')) in ('QUITADO','CANCELADO','CANCELADA') and new.status is distinct from old.status)
  execute function public.tg_acordo_alerta_resolve_acordo();

-- 6) RPC de consumo (front): operador ve os seus; gestao ve todos; p_aluno_id opcional. Somente leitura.
CREATE OR REPLACE FUNCTION public.acordo_alertas_do_operador(p_aluno_id uuid DEFAULT NULL)
 RETURNS TABLE(aluno_id uuid, aluno_nome text, acordo_id uuid, numero_acordo int, parcela_id uuid, numero_parcela int, valor numeric,
               vencimento date, dias_restantes int, data_alerta date, responsavel_email text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select x.aluno_id, al.nome::text, x.acordo_id, a.numero_acordo::int, x.parcela_id, x.numero_parcela::int, x.valor::numeric, x.vencimento,
         (x.vencimento - current_date)::int, x.data_alerta, x.responsavel_email
    from public.acordo_alertas_parcela x
    join public.acordos a on a.id = x.acordo_id
    left join public.alunos al on al.id = x.aluno_id
   where x.resolvido_em is null and x.tipo = 'D2'
     and (p_aluno_id is null or x.aluno_id = p_aluno_id)
     and (public.usuario_e_gestao() or lower(coalesce(x.responsavel_email,'')) = lower(coalesce(auth.jwt()->>'email','')))
   order by x.vencimento, al.nome;
$function$;
revoke all on function public.acordo_alertas_do_operador(uuid) from public, anon;
grant execute on function public.acordo_alertas_do_operador(uuid) to authenticated, service_role;

insert into public.calibragem_parametros (chave, valor, descricao)
values ('alerta_parcela_d2', '{"dias": 2, "modo": "CORRIDO"}'::jsonb, 'D-2 do alerta de parcela de acordo: dias antes do vencimento e modo (CORRIDO|UTIL).')
on conflict (chave) do nothing;

-- Gestao: alertas cujo acordo/aluno nao tem responsavel (so identifica; NAO distribui).
CREATE OR REPLACE FUNCTION public.acordo_alertas_sem_responsavel()
 RETURNS TABLE(aluno_id uuid, aluno_nome text, acordo_id uuid, numero_acordo int, parcela_id uuid, numero_parcela int, valor numeric, vencimento date, dias_restantes int, data_alerta date)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if not public.usuario_e_gestao() then raise exception 'Acesso negado: somente gestao.' using errcode = '42501'; end if;
  return query
  select x.aluno_id, al.nome::text, x.acordo_id, a.numero_acordo::int, x.parcela_id, x.numero_parcela::int, x.valor::numeric, x.vencimento, (x.vencimento - current_date)::int, x.data_alerta
    from public.acordo_alertas_parcela x join public.acordos a on a.id = x.acordo_id left join public.alunos al on al.id = x.aluno_id
   where x.resolvido_em is null and x.tipo = 'D2' and nullif(btrim(coalesce(x.responsavel_email,'')),'') is null
   order by x.vencimento, al.nome;
end;
$function$;
revoke all on function public.acordo_alertas_sem_responsavel() from public, anon;
grant execute on function public.acordo_alertas_sem_responsavel() to authenticated, service_role;

-- Funcoes de rotina: so servico/gestao (nao expostas a operador).
revoke all on function public.acordo_alertas_gerar(date,int,text), public.acordo_alertas_resolver(date), public.acordo_classificar(uuid,date), public.acordo_alerta_data(date,int,text) from public, anon, authenticated;
grant execute on function public.acordo_alertas_gerar(date,int,text), public.acordo_alertas_resolver(date) to service_role;

commit;
