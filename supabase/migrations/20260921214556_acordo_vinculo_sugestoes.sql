-- FILA ASSISTIDA DE VINCULO DE MENSALIDADES AOS ACORDOS (sugestao por evidencia Prime/portador 195).
--
-- NADA aqui vincula sozinho. A leitura sugere; a gestao CONFIRMA (revalidacao no servidor + RPC OFICIAL vincular_titulos_acordo) ou REJEITA.
--   acordo_vinculo_sugestoes_calcular(p_acordo_id)   nucleo SOMENTE LEITURA (interno: so service_role/postgres)
--   acordos_vinculo_sugestoes()                      RPC de gestao (mesmo portao da fila atual): FORTE | REVISAO | SEM_EVIDENCIA + rejeicoes
--   acordo_vinculo_sugestao_confirmar(acordo, hash)  revalida; so FORTE com a MESMA composicao; chama vincular_titulos_acordo
--   acordo_vinculo_sugestao_rejeitar(acordo, hash, motivo)   grava a COMPOSICAO rejeitada (hash dos titulo_id ordenados); nao altera nada financeiro
-- Regra validada em retroteste (1.219 acordos vinculados a mao): janela -60/+7, CPF, documento exato, titulo ABERTO/livre/vencido na liquidacao,
-- nenhum outro acordo do aluno (INCLUSIVE cancelado) competindo pelo mesmo grupo. Valor do acordo NUNCA entra. Sem job, sem cron, sem backfill.
begin;

create table if not exists public.acordo_vinculo_sugestao_decisao (
  id            uuid primary key default gen_random_uuid(),
  acordo_id     uuid not null references public.acordos(id) on delete cascade,
  composicao_hash text not null,
  titulo_ids    uuid[] not null,
  decisao       text not null check (decisao in ('REJEITADA','CONFIRMADA')),
  nivel         text,
  motivo        text,
  decidido_por  text not null,
  decidido_em   timestamptz not null default now()
);
-- uma rejeicao por (acordo, composicao): repetir e idempotente
create unique index if not exists acordo_vinculo_sugestao_rejeicao_uq
  on public.acordo_vinculo_sugestao_decisao (acordo_id, composicao_hash) where decisao = 'REJEITADA';
create index if not exists acordo_vinculo_sugestao_decisao_acordo_idx on public.acordo_vinculo_sugestao_decisao (acordo_id);
alter table public.acordo_vinculo_sugestao_decisao enable row level security;
revoke all on table public.acordo_vinculo_sugestao_decisao from public, anon, authenticated;
grant select on table public.acordo_vinculo_sugestao_decisao to authenticated;
grant select, insert, update, delete on table public.acordo_vinculo_sugestao_decisao to service_role;
drop policy if exists avsd_gestao_le on public.acordo_vinculo_sugestao_decisao;
create policy avsd_gestao_le on public.acordo_vinculo_sugestao_decisao for select to authenticated using (public.usuario_e_gestao());

-- NUCLEO (somente leitura). Os trechos marcados RETRO_* existem so para o retroteste substituir o filtro "sem vinculo / titulo livre"
-- pelo estado PRE-vinculo dos acordos ja vinculados a mao; em producao sao exatamente o texto abaixo.
CREATE OR REPLACE FUNCTION public.acordo_vinculo_sugestoes_calcular(p_acordo_id uuid DEFAULT NULL)
 RETURNS TABLE(acordo_id uuid, aluno_id uuid, nome text, cpf text, responsavel_email text, numero_acordo text, status text,
               criado_em timestamptz, valor_total numeric, saldo numeric, nivel text, motivo text, liquidacao_195 date,
               composicao_hash text, titulos jsonb, concorrentes jsonb, qtd_grupos_janela int)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
#variable_conflict use_column
begin
  return query
  with ac as materialized (
    select a.id, a.aluno_id, a.numero_acordo::text nro, upper(coalesce(a.status,'')) st, a.criado_em, a.criado_em::date cr,
           a.valor_total, coalesce(a.saldo,0) saldo, al.nome, al.cpf, regexp_replace(coalesce(al.cpf,''),'\D','','g') cpf_n,
           al.responsavel_atual_email resp
      from public.acordos a join public.alunos al on al.id = a.aluno_id
     where upper(coalesce(a.status,'')) in ('ATIVO','QUITADO')
       and (p_acordo_id is null or a.id = p_acordo_id)
       and /*RETRO_ACORDOS*/ not exists (select 1 from public.acordo_titulo_vinculo v join public.acordos_titulos t on t.id = v.titulo_id
                         and coalesce(t.tipo_boleto,'') <> 'Acordo' where v.acordo_id = a.id and coalesce(v.ativo,true)) /*FIM_RETRO*/
  ), e195 as materialized (
    select ltrim(e.boleto,'0') bol, regexp_replace(coalesce(e.cpf,''),'\D','','g') cpf_n, e.liquidado_em
      from public.prime_extrato e
     where e.portador = 195 and e.liquidado_em is not null
       and regexp_replace(coalesce(e.cpf,''),'\D','','g') in (select x.cpf_n from ac x where x.cpf_n <> '')
  ), tit as materialized (
    select t.id, t.aluno_id, t.documento, ltrim(t.documento,'0') doc, t.competencia, t.vencimento, upper(coalesce(t.situacao,'')) sit,
           lower(coalesce(t.status,'')) stt, t.acordo_id, coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) valor
      from public.acordos_titulos t
     where t.aluno_id in (select x.aluno_id from ac x) and coalesce(t.tipo_boleto,'') <> 'Acordo'
  ), el as materialized (
    select ac.id acordo_id, t.id tid, t.documento, t.competencia, t.vencimento, t.sit, t.stt, t.valor, min(e.liquidado_em) liq
      from ac join tit t on t.aluno_id = ac.aluno_id
      join e195 e on e.cpf_n = ac.cpf_n and e.bol = t.doc
     where ac.cpf_n <> '' and t.vencimento <= e.liquidado_em
       and /*RETRO_TITULO*/ (t.sit = 'ABERTO' and t.acordo_id is null
            and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo,true))) /*FIM_RETRO*/
     group by ac.id, t.id, t.documento, t.competencia, t.vencimento, t.sit, t.stt, t.valor
  ), gr as materialized (
    select el.acordo_id, el.liq d, jsonb_agg(jsonb_build_object('titulo_id', el.tid, 'documento', el.documento, 'competencia', el.competencia,
             'vencimento', el.vencimento, 'valor', el.valor, 'situacao', el.sit, 'status', el.stt, 'liquidacao_195', el.liq)
             order by el.vencimento, el.tid) tits, array_agg(el.tid order by el.tid) ids
      from el group by el.acordo_id, el.liq
  ), gj as materialized (
    select g.acordo_id, g.d, g.tits, g.ids, (g.d between ac.cr - 60 and ac.cr + 7) na_janela,
           (select jsonb_agg(jsonb_build_object('acordo_id', b.id, 'numero_acordo', b.numero_acordo, 'status', b.status, 'criado_em', b.criado_em::date)
                             order by b.criado_em)
              from public.acordos b
             where b.aluno_id = ac.aluno_id and b.id <> ac.id
               and g.d between b.criado_em::date - 60 and b.criado_em::date + 7) conc
      from gr g join ac on ac.id = g.acordo_id
  ), r as (
    select ac.*, (select count(*) from gj x where x.acordo_id = ac.id and x.na_janela)::int ng_win,
           (select count(*) from gj x where x.acordo_id = ac.id)::int ng_tot,
           exists (select 1 from gj x where x.acordo_id = ac.id and x.na_janela and x.conc is not null) tem_conc
      from ac
  )
  select r.id, r.aluno_id, r.nome, r.cpf, r.resp, r.nro, r.st, r.criado_em, r.valor_total, r.saldo,
         case when r.ng_win = 0 then 'SEM_EVIDENCIA' when r.ng_win = 1 and not r.tem_conc then 'FORTE' else 'REVISAO' end,
         case when r.cpf_n = '' then 'ALUNO_SEM_CPF'
              when r.ng_win = 0 and r.ng_tot = 0 then 'SEM_GRUPO_195'
              when r.ng_win = 0 then 'GRUPO_195_FORA_DA_JANELA'
              when r.ng_win > 1 then 'MULTIPLOS_GRUPOS_195'
              when r.tem_conc then 'ACORDO_CONCORRENTE'
              else 'UNICO_GRUPO_195_COMPATIVEL' end,
         (select min(x.d) from gj x where x.acordo_id = r.id and x.na_janela),
         (select md5(string_agg(q.tid::text, ',' order by q.tid)) from (select unnest(x.ids) tid from gj x where x.acordo_id = r.id and x.na_janela) q),
         coalesce((select jsonb_agg(el2 order by el2->>'vencimento', el2->>'titulo_id')
                     from gj x, jsonb_array_elements(x.tits) el2 where x.acordo_id = r.id and x.na_janela), '[]'::jsonb),
         (select jsonb_agg(distinct c) from gj x, jsonb_array_elements(x.conc) c where x.acordo_id = r.id and x.na_janela and x.conc is not null),
         r.ng_win
    from r;
end;
$function$;
revoke all on function public.acordo_vinculo_sugestoes_calcular(uuid) from public, anon, authenticated;
grant execute on function public.acordo_vinculo_sugestoes_calcular(uuid) to service_role;

-- RPC de leitura (mesmo portao de acordos_sem_vinculo_fila: cron/servico sem JWT passa; usuario logado so se for gestao).
CREATE OR REPLACE FUNCTION public.acordos_vinculo_sugestoes()
 RETURNS TABLE(acordo_id uuid, aluno_id uuid, nome text, cpf text, responsavel_email text, numero_acordo text, status text,
               criado_em timestamptz, valor_total numeric, saldo numeric, nivel text, motivo text, liquidacao_195 date,
               composicao_hash text, titulos jsonb, concorrentes jsonb, qtd_grupos_janela int,
               rejeitada boolean, rejeitado_por text, rejeitado_em timestamptz, motivo_rejeicao text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' SET statement_timeout TO '30s'
AS $function$
#variable_conflict use_column
begin
  if not (auth.jwt() is null or public.usuario_e_gestao()) then return; end if;
  return query
  select s.acordo_id, s.aluno_id, s.nome, s.cpf, s.responsavel_email, s.numero_acordo, s.status, s.criado_em, s.valor_total, s.saldo,
         s.nivel, s.motivo, s.liquidacao_195, s.composicao_hash, s.titulos, s.concorrentes, s.qtd_grupos_janela,
         (d.id is not null), d.decidido_por, d.decidido_em, d.motivo
    from public.acordo_vinculo_sugestoes_calcular(null) s
    left join lateral (select x.id, x.decidido_por, x.decidido_em, x.motivo from public.acordo_vinculo_sugestao_decisao x
                        where x.acordo_id = s.acordo_id and x.composicao_hash = s.composicao_hash and x.decisao = 'REJEITADA'
                        order by x.decidido_em desc limit 1) d on s.composicao_hash is not null
   order by case s.nivel when 'FORTE' then 1 when 'REVISAO' then 2 else 3 end, s.valor_total desc nulls last, s.acordo_id;
end;
$function$;
revoke all on function public.acordos_vinculo_sugestoes() from public, anon;
grant execute on function public.acordos_vinculo_sugestoes() to authenticated, service_role;

-- CONFIRMAR: revalida NO SERVIDOR (acordo elegivel, titulos livres/elegiveis, documentos e CPF conferindo, nenhuma concorrencia nova) e so entao
-- chama a RPC OFICIAL vincular_titulos_acordo. Nao replica a gravacao do vinculo.
CREATE OR REPLACE FUNCTION public.acordo_vinculo_sugestao_confirmar(p_acordo_id uuid, p_composicao_hash text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' SET statement_timeout TO '30s'
AS $function$
#variable_conflict use_column
declare v_email text := lower(coalesce(auth.email(),'')); s record; v_ids uuid[]; v_res jsonb;
begin
  if not public.usuario_e_gestao() then raise exception 'Acesso negado: somente gestao.' using errcode = '42501'; end if;
  if v_email = '' then return jsonb_build_object('ok', false, 'erro', 'NAO_AUTENTICADO'); end if;
  select * into s from public.acordo_vinculo_sugestoes_calcular(p_acordo_id);
  if not found then return jsonb_build_object('ok', false, 'erro', 'ACORDO_NAO_ELEGIVEL'); end if;
  if s.nivel <> 'FORTE' then
    return jsonb_build_object('ok', false, 'erro', 'SUGESTAO_NAO_E_FORTE', 'nivel', s.nivel, 'motivo', s.motivo);
  end if;
  if s.composicao_hash is distinct from p_composicao_hash then
    return jsonb_build_object('ok', false, 'erro', 'SUGESTAO_MUDOU', 'composicao_atual', s.composicao_hash);
  end if;
  select array_agg((x->>'titulo_id')::uuid order by (x->>'titulo_id')::uuid) into v_ids from jsonb_array_elements(s.titulos) x;
  v_res := public.vincular_titulos_acordo(v_ids, p_acordo_id);
  if not coalesce((v_res->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'erro', 'VINCULO_RECUSADO', 'detalhe', v_res);
  end if;
  insert into public.acordo_vinculo_sugestao_decisao (acordo_id, composicao_hash, titulo_ids, decisao, nivel, motivo, decidido_por)
  values (p_acordo_id, s.composicao_hash, v_ids, 'CONFIRMADA', s.nivel, s.motivo, v_email);
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'SUGESTAO_VINCULO_CONFIRMADA', 'acordos', p_acordo_id,
          jsonb_build_object('composicao_hash', s.composicao_hash, 'titulo_ids', v_ids, 'motivo', s.motivo, 'liquidacao_195', s.liquidacao_195));
  return jsonb_build_object('ok', true, 'acordo_id', p_acordo_id, 'titulo_ids', v_ids, 'resultado', v_res);
end;
$function$;
revoke all on function public.acordo_vinculo_sugestao_confirmar(uuid, text) from public, anon;
grant execute on function public.acordo_vinculo_sugestao_confirmar(uuid, text) to authenticated, service_role;

-- REJEITAR: grava a COMPOSICAO (titulo_id ordenados, calculada no servidor). Nao altera acordo, mensalidades, parcelas nem pagamentos.
CREATE OR REPLACE FUNCTION public.acordo_vinculo_sugestao_rejeitar(p_acordo_id uuid, p_composicao_hash text, p_motivo text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' SET statement_timeout TO '30s'
AS $function$
#variable_conflict use_column
declare v_email text := lower(coalesce(auth.email(),'')); s record; v_ids uuid[]; v_n int;
begin
  if not public.usuario_e_gestao() then raise exception 'Acesso negado: somente gestao.' using errcode = '42501'; end if;
  if v_email = '' then return jsonb_build_object('ok', false, 'erro', 'NAO_AUTENTICADO'); end if;
  select * into s from public.acordo_vinculo_sugestoes_calcular(p_acordo_id);
  if not found then return jsonb_build_object('ok', false, 'erro', 'ACORDO_NAO_ELEGIVEL'); end if;
  if s.composicao_hash is null then return jsonb_build_object('ok', false, 'erro', 'SEM_COMPOSICAO_PARA_REJEITAR'); end if;
  if s.composicao_hash is distinct from p_composicao_hash then
    return jsonb_build_object('ok', false, 'erro', 'SUGESTAO_MUDOU', 'composicao_atual', s.composicao_hash);
  end if;
  select array_agg((x->>'titulo_id')::uuid order by (x->>'titulo_id')::uuid) into v_ids from jsonb_array_elements(s.titulos) x;
  insert into public.acordo_vinculo_sugestao_decisao (acordo_id, composicao_hash, titulo_ids, decisao, nivel, motivo, decidido_por)
  values (p_acordo_id, s.composicao_hash, v_ids, 'REJEITADA', s.nivel, nullif(btrim(coalesce(p_motivo,'')),''), v_email)
  on conflict (acordo_id, composicao_hash) where decisao = 'REJEITADA' do nothing;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values (v_email, 'SUGESTAO_VINCULO_REJEITADA', 'acordos', p_acordo_id,
            jsonb_build_object('composicao_hash', s.composicao_hash, 'titulo_ids', v_ids, 'nivel', s.nivel, 'motivo_sugestao', s.motivo,
                               'motivo_rejeicao', nullif(btrim(coalesce(p_motivo,'')),'')));
  end if;
  return jsonb_build_object('ok', true, 'acordo_id', p_acordo_id, 'composicao_hash', s.composicao_hash, 'ja_rejeitada', v_n = 0);
end;
$function$;
revoke all on function public.acordo_vinculo_sugestao_rejeitar(uuid, text, text) from public, anon;
grant execute on function public.acordo_vinculo_sugestao_rejeitar(uuid, text, text) to authenticated, service_role;

commit;
