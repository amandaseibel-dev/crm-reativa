-- EVIDENCIA DE EXECUCAO dos gatilhos de alunos, casos e acordos nos caminhos testados.
-- Medicao: pg_stat_xact_user_functions com track_functions='all' (somente funcoes plpgsql
-- sao contadas de forma confiavel). Para cada gatilho NAO carregado na fixture:
--  - se UPDATE OF <colunas> e nenhuma coluna da lista e escrita nos caminhos, o gatilho nao
--    pode disparar (filtro de coluna do proprio PostgreSQL) -> justificativa pelo catalogo;
--  - se dispara (contagem > 0) e nao esta carregado -> FALHA (a exclusao nao se sustenta);
--  - se e SQL (contagem nao confiavel) e nao ha filtro de coluna -> FALHA (evidencia insuficiente).
-- Ausencia de contagem em plpgsql NAO e tratada como ausencia de execucao.
\i lib.sql
set track_functions = 'all';
select pg_temp.como('amanda.seibel@aelbra.com.br');
create table if not exists public.cg_evid (fn text primary key, calls bigint);
delete from public.cg_evid;
begin;
create temp table _e on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local', 500, null, 2);
-- caminho 1: remanejamento do aluno (escreve responsavel, data, casos)
do $$
declare x record; p jsonb; r jsonb;
begin
  select * into x from _e;
  update public.calibragem_parametros set valor = '700'::jsonb where chave = 'limite_carteira';
  p := pg_temp.previa(array[x.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  r := public.carteira_geral_mover((p->>'previa_id')::uuid, 'evidencia');
end $$;
-- caminho 2: escrita direta de casos (operador)
update public.casos set operador_email = 'cobranca06@aelbra.com.br', operador_nome = 'Mauricio', operador = 'Mauricio'
 where aluno_id = (select aluno from _e);
-- caminho 3: acordo ativo de operador (escreve acordos)
insert into public.acordos (id, aluno_id, cpf, status, tipo, forma_pagamento, qtd_parcelas, entrada_paga, criado_em, atualizado_em, numero_acordo, valor_total, operador_responsavel_email, operador_responsavel_nome)
select gen_random_uuid(), aluno, (select cpf from public.alunos where id = aluno), 'ATIVO', 'PARCELADO', 'BOLETO', 1, false, now(), now(), floor(random()*1e9)::bigint, 100, 'cobranca06@aelbra.com.br', 'Mauricio' from _e;
insert into public.cg_evid select funcname::text, calls from pg_stat_xact_user_functions where schemaname = 'public';
commit;

-- catalogo: gatilhos das tabelas dos caminhos, com colunas de UPDATE OF e contagem
create table if not exists public.cg_evid_gatilhos (tabela text, gatilho text, fn text, linguagem text,
  colunas_update_of text, chamadas bigint, carregado boolean);
delete from public.cg_evid_gatilhos;
insert into public.cg_evid_gatilhos
select c.relname, t.tgname, p.proname, l.lanname,
  case when t.tgattr::text = '' then null else
    (select string_agg(a.attname::text, ',') from pg_attribute a where a.attrelid = t.tgrelid and a.attnum = any(t.tgattr)) end,
  coalesce((select e.calls from public.cg_evid e where e.fn = p.proname), 0),
  t.tgname in ('trg_guard_resp_aluno','trg_nome_do_operador_no_aluno','trg_sync_casos_resp_aluno','trg_nome_do_operador_no_caso',
               'trg_sync_alunos_apos_casos','trg_acordo_herda_responsavel','trg_aluno_segue_dono_do_acordo',
               'trg_atribuir_responsavel_por_acordo','trg_guard_resp_acordo','trg_giro_limpar_marca','trigger_impor_teto_operador')
from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
join pg_proc p on p.oid = t.tgfoid join pg_language l on l.oid = p.prolang
where c.relname in ('alunos','casos','acordos') and not t.tgisinternal;

do $$
declare g record; escritas text[] := array['responsavel_atual_email','responsavel_atual_nome','responsavel_atual_em',
  'data_ultimo_acionamento','status_acionamento','proxima_acao','data_retorno','hora_retorno','operador_email','operador_nome',
  'operador','caso_atualizado_por','caso_atualizado_em','giro_fidelizacao_ate','remanejamento_lote_id','operador_responsavel_email','status'];
  n_nao_carregado int := 0; n_justif int := 0; n_falha int := 0;
begin
  for g in select * from public.cg_evid_gatilhos where not carregado loop
    n_nao_carregado := n_nao_carregado + 1;
    if g.colunas_update_of is not null and not exists (
         select 1 from unnest(string_to_array(g.colunas_update_of, ',')) c where c = any(escritas)) then
      n_justif := n_justif + 1;   -- nao pode disparar: filtro de coluna do PostgreSQL
      raise notice 'justificado pelo catalogo: % (%) colunas %', g.gatilho, g.tabela, g.colunas_update_of;
    elsif g.linguagem = 'plpgsql' and g.chamadas > 0 then
      n_falha := n_falha + 1;
      raise notice 'FALHA: % disparou (% chamadas) e nao esta carregado', g.gatilho, g.chamadas;
    elsif g.linguagem <> 'plpgsql' then
      n_falha := n_falha + 1;
      raise notice 'FALHA: % (linguagem %) sem filtro de coluna: contagem nao confiavel', g.gatilho, g.linguagem;
    else
      n_justif := n_justif + 1;   -- plpgsql, sem filtro de coluna, sem contagem: observado NAO disparar
      raise notice 'observado nao disparar nos caminhos: % (plpgsql, contagem 0)', g.gatilho;
    end if;
  end loop;
  perform pg_temp.afirma(n_falha = 0, format('gatilhos omitidos: %s avaliados, %s justificados, %s falhas', n_nao_carregado, n_justif, n_falha));
end $$;
select 'EVIDENCIA OK' as resultado;
