-- GRUPO A, ETAPA 2 -- RESTANTE, depois do piloto de 5 aprovado nas rotinas. Autorizado pela gestao em 18/09/2026.
-- Usa a funcao oficial prime_conferencia_detectar_grupo_a(true), sem lista: ela revalida cada
-- candidato no instante (so ABERTO/NEGOCIADO, sem decisao PENDENTE/CONFIRMADO/VINCULADO) e e
-- idempotente. Qualquer conferencia abaixo que falhe desfaz TUDO (raise na mesma transacao).
set local statement_timeout = '600s';
do $resto$
declare
  v_res    jsonb;
  v_fila   bigint;
  v_n      int;
  v_susp   int;
  v_md5    text;
begin
  -- funcoes exatamente as da versao 20260918144637
  select md5(string_agg(proname || '=' || md5(prosrc), ',' order by proname)) into v_md5
    from pg_proc where pronamespace = 'public'::regnamespace and proname = any(array['_talvez_quitar_aluno','_titulo_em_confirmacao_protegido','_titulo_situacao_e_status_coerentes','_trg_auto_quitar_titulo','aluno_saldo_pendente_detalhe','assumir_caso_livre','caso_aguarda_confirmacao_financeira','caso_protegido_redistribuicao','casos_encerrar_zerados_sem_debito','casos_reavaliar_encerramento','contar_carteira_ativa','nivelar_medias_progressivo','prime_conferencia_baixar','prime_conferencia_confirmar','prime_conferencia_detectar_grupo_a','prime_conferencia_fila','prime_conferencia_rejeitar','prime_conferencia_rejeitar_lote','prime_conferencia_vincular','prime_grupo_a_candidatos','recalcular_situacao_aluno','reforcar_teto_operadores','titulo_liquidado_na_origem_e_terminal']);
  if v_md5 is distinct from 'd9e15cb291b2aa3c05f3a0f0f335f732' then
    raise exception 'RESTO_PRE: funcoes do grupo A mudaram (%)', v_md5;
  end if;
  -- ponto de partida: so o piloto em confirmacao, reposicao pausada
  if (select count(*) from public.acordos_titulos where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO') <> 5
     or (select count(*) from public.prime_conferencia_decisao) <> 5
     or (select count(*) from public.prime_conferencia_decisao where decisao = 'PENDENTE') <> 5 then
    raise exception 'RESTO_PRE: estado inicial diferente do piloto (5 em confirmacao, 5 PENDENTE)';
  end if;
  if exists (select 1 from cron.job where command ilike '%reposicao%' and active) then
    raise exception 'RESTO_PRE: reposicao de carteira nao esta pausada';
  end if;

  -- fotografia no instante: candidatos vivos e tudo o que e deles
  create temp table _cand on commit drop as
    select c.titulo_id, c.aluno_id, c.subgrupo, c.valor
      from public.prime_grupo_a_candidatos(null) c
      join public.acordos_titulos t on t.id = c.titulo_id
     where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
       and not exists (select 1 from public.prime_conferencia_decisao d
                        where d.titulo_id = c.titulo_id
                          and (d.decisao in ('PENDENTE','CONFIRMADO','VINCULADO')
                               or (d.decisao = 'REJEITADO'
                                   and (d.evidencia_chave is null or d.evidencia_chave = c.evidencia_chave))));
  create temp table _t0 on commit drop as
    select id, situacao, status, valor_original, saldo_corrigido, valor_em_aberto, valor_cobranca_ajustado,
           acordo_id, aluno_id, documento, vencimento, origem_liquidacao
      from public.acordos_titulos where aluno_id in (select aluno_id from _cand);
  create temp table _c0 on commit drop as
    select id, aluno_id, operador_email, encerrado_operacional from public.casos where aluno_id in (select aluno_id from _cand);
  create temp table _a0 on commit drop as
    select id, status_atual, status_jornada, responsavel_atual_email, situacao_operacional from public.alunos where id in (select aluno_id from _cand);
  select coalesce(max(id), 0) into v_fila from public.reposicao_carteira_fila;

  v_res := public.prime_conferencia_detectar_grupo_a(true);
  v_susp := coalesce((v_res->>'suspensos')::int, -1);

  -- suspensos = exatamente os candidatos da fotografia
  if v_susp <> (select count(*) from _cand) or v_susp < 1 then
    raise exception 'RESTO: suspensos % <> candidatos % (%)', v_susp, (select count(*) from _cand), v_res;
  end if;
  if exists (select 1 from _cand c join public.acordos_titulos t on t.id = c.titulo_id
              where t.situacao <> 'EM_CONFIRMACAO' or t.status <> 'em_confirmacao') then
    raise exception 'RESTO: candidato nao ficou EM_CONFIRMACAO/em_confirmacao';
  end if;
  if (select count(*) from public.acordos_titulos where upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO') <> 5 + v_susp then
    raise exception 'RESTO: EM_CONFIRMACAO fora dos candidatos';
  end if;
  -- titulos: valores, acordo, documento e origem intactos; os demais titulos desses alunos nem mudam de situacao
  select count(*) into v_n from public.acordos_titulos t join _t0 p on p.id = t.id
   where (t.valor_original, t.saldo_corrigido, t.valor_em_aberto, t.valor_cobranca_ajustado, t.acordo_id, t.aluno_id,
          t.documento, t.vencimento, t.origem_liquidacao)
         is distinct from
         (p.valor_original, p.saldo_corrigido, p.valor_em_aberto, p.valor_cobranca_ajustado, p.acordo_id, p.aluno_id,
          p.documento, p.vencimento, p.origem_liquidacao);
  if v_n <> 0 then raise exception 'RESTO: % titulos mudaram valor/acordo/documento/origem', v_n; end if;
  select count(*) into v_n from public.acordos_titulos t join _t0 p on p.id = t.id
   where p.id not in (select titulo_id from _cand)
     and (t.situacao, t.status) is distinct from (p.situacao, p.status);
  if v_n <> 0 then raise exception 'RESTO: % titulos fora do grupo A mudaram de situacao', v_n; end if;
  if (select count(*) from _t0) <> (select count(*) from public.acordos_titulos where aluno_id in (select aluno_id from _cand)) then
    raise exception 'RESTO: numero de titulos dos alunos mudou';
  end if;
  -- decisoes PENDENTE com o subgrupo da fotografia
  if (select count(*) from public.prime_conferencia_decisao where decisao = 'PENDENTE') <> 5 + v_susp
     or exists (select 1 from _cand c left join public.prime_conferencia_decisao d on d.titulo_id = c.titulo_id
                 where d.titulo_id is null or d.decisao <> 'PENDENTE' or d.subgrupo is distinct from c.subgrupo
                    or d.motivo_entrada is distinct from 'LIQUIDACAO_PRIME_CORROBORADA') then
    raise exception 'RESTO: decisoes fora do esperado';
  end if;
  -- casos: nenhum encerrado, nenhum trocou de responsavel
  select count(*) into v_n from public.casos c join _c0 p on p.id = c.id
   where (c.operador_email, c.encerrado_operacional) is distinct from (p.operador_email, p.encerrado_operacional);
  if v_n <> 0 then raise exception 'RESTO: % casos encerrados ou com responsavel trocado', v_n; end if;
  if (select count(*) from _c0) <> (select count(*) from public.casos where aluno_id in (select aluno_id from _cand)) then
    raise exception 'RESTO: numero de casos dos alunos mudou';
  end if;
  -- alunos: status e responsavel intactos; ninguem passa a QUITADO
  select count(*) into v_n from public.alunos a join _a0 p on p.id = a.id
   where (a.status_atual, a.status_jornada, a.responsavel_atual_email)
         is distinct from (p.status_atual, p.status_jornada, p.responsavel_atual_email);
  if v_n <> 0 then raise exception 'RESTO: % alunos mudaram de status ou responsavel', v_n; end if;
  if exists (select 1 from public.alunos a join _a0 p on p.id = a.id
              where upper(coalesce(a.situacao_operacional,'')) like 'QUITADO%'
                and upper(coalesce(p.situacao_operacional,'')) not like 'QUITADO%') then
    raise exception 'RESTO: aluno virou QUITADO';
  end if;
  -- nenhuma reposicao enfileirada
  if (select coalesce(max(id), 0) from public.reposicao_carteira_fila) <> v_fila then
    raise exception 'RESTO: reposicao enfileirada';
  end if;
end;
$resto$;
