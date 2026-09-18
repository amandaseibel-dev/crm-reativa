-- PRIMEIRO LOTE CONTROLADO da recuperacao do acordo a vista (18/09/2026).
-- Etapa ainda DESLIGADA: a rotina e chamada uma vez, aqui. Tudo ou nada.
-- 3a tentativa. Responsavel do aluno: aceito (a) igual, (b) liberado porque o
-- aluno quitou e foi encerrado pela rotina existente -- o mesmo efeito do
-- botao da gestao nos 7 a vista ja registrados --, ou (c) preenchido com o
-- operador do pagamento quando estava vazio (o que a previa anuncia).
do $lote$
declare
  v_r jsonb; v_t0 timestamptz; v_ms numeric; v_falhas text[] := '{}'; v_itens jsonb;
  v_pjp_a text; v_parc_a text; v_acor_a text; v_tit_a text; v_rec_a text; v_saldo_a numeric; v_saldo_d numeric;
  v_n int;
begin
  if (select ligado from public.fluxo_pagamentos_config where etapa = 'recuperar_acordo_avista') is distinct from false then
    raise exception 'LOTE: a etapa deveria estar desligada';
  end if;
  if exists (select 1 from pg_stat_activity where query ilike '%fluxo_pagamentos_rodar%' and pid <> pg_backend_pid() and state = 'active') then
    raise exception 'LOTE: rodada horaria em curso';
  end if;
  if exists (select 1 from cron.job where jobname = 'reposicao_carteira_minuto' and active) then
    raise exception 'LOTE: a reposicao de carteira deveria estar pausada';
  end if;

  create temp table _av on commit drop as
  select x.pag, x.valor_pago, (x.v -> 'aluno' ->> 'id')::uuid as aluno,
         x.v -> 'acordo_a_criar' ->> 'numero_ulbra' as numero,
         lower(x.v -> 'acordo_a_criar' ->> 'operador_responsavel_email') as op,
         (x.v -> 'titulos' ->> 'soma')::numeric as soma,
         (select array_agg((t ->> 'id')::uuid) from jsonb_array_elements(x.v -> 'titulos' -> 'selecionados') t
           where t ->> 'impedimento' is null) as tits
    from (select g.id as pag, g.valor_pago, public.acordo_avista_previa(g.id, null) as v
            from public.pagamentos g
            join public.fila_pagamento_sem_vinculo f on f.pagamento_id = g.id and f.decisao is null
           where g.status_conciliacao = 'AGUARDANDO_ACORDO'
             and ltrim(coalesce(g.numero_parcela_completo, ''), '0') ~ '^5\d{6}0001$'
             and not exists (select 1 from public.parcelas q where q.boleto = ltrim(g.numero_parcela_completo, '0'))
             and not exists (select 1 from public.acordos a where a.numero_ulbra is not null
                               and lpad(a.numero_ulbra, 6, '0') = substr(ltrim(g.numero_parcela_completo, '0'), 2, 6))) x
   where coalesce((x.v ->> 'aprovado')::boolean, false);

  create temp table _al on commit drop as
  select a.id, a.responsavel_atual_email, a.status_atual, a.saldo_total from public.alunos a where a.id in (select aluno from _av);
  create temp table _ac_antes on commit drop as select id from public.acordos;

  select md5(string_agg(g.id::text || coalesce(g.status_conciliacao,'') || coalesce(f.decisao,'') || coalesce(g.conciliacao_motivo,''), '|' order by g.id))
    into v_pjp_a from public.pagamentos g join public.fila_pagamento_sem_vinculo f on f.pagamento_id = g.id where g.status_conciliacao = 'PARCELA_JA_PAGA';
  select md5(string_agg(q.id::text || coalesce(q.status,'') || coalesce(q.valor,0)::text || coalesce(q.origem_baixa_ref,''), '|' order by q.id)) into v_parc_a from public.parcelas q;
  select md5(string_agg(a.id::text || coalesce(a.status,'') || coalesce(a.saldo,0)::text, '|' order by a.id)) into v_acor_a from public.acordos a;
  select md5(string_agg(t.id::text || coalesce(t.situacao,'') || coalesce(t.status,'') || coalesce(t.acordo_id::text,''), '|' order by t.id))
    into v_tit_a from public.acordos_titulos t where not (t.id = any(coalesce((select array_agg(u) from _av, unnest(tits) u), '{}')));
  select md5(string_agg(g.id::text || coalesce(g.status_conciliacao,'') || coalesce(g.aluno_id::text,'') || g.valor_pago::text || coalesce(f.decisao,''), '|' order by g.id))
    into v_rec_a from public.pagamentos g join public.fila_pagamento_sem_vinculo f on f.pagamento_id = g.id
   where g.status_conciliacao = 'AGUARDANDO_ACORDO' and g.id not in (select pag from _av);
  select round(sum(saldo_total),2) into v_saldo_a from public.alunos;

  v_t0 := clock_timestamp();
  v_r := public.acordo_avista_recuperar_pendentes(50);
  v_ms := round(extract(epoch from clock_timestamp() - v_t0) * 1000);
  select round(sum(saldo_total),2) into v_saldo_d from public.alunos;

  if (v_r ->> 'erros')::int <> 0 then v_falhas := v_falhas || ('erros: ' || (v_r -> 'itens')::text); end if;
  if (v_r ->> 'recuperados')::int <> (select count(*) from _av) then
    v_falhas := v_falhas || ('recuperados ' || (v_r ->> 'recuperados') || ' <> aprovados ' || (select count(*) from _av)::text);
  end if;
  if exists (select 1 from jsonb_array_elements(v_r -> 'itens') i where (i ->> 'gravou')::boolean
               and (i ->> 'pagamento_id')::uuid not in (select pag from _av)) then
    v_falhas := v_falhas || 'gravou pagamento que a previa nao aprovou'::text;
  end if;
  if (select count(*) from public.acordos where id not in (select id from _ac_antes)) <> (select count(*) from _av) then
    v_falhas := v_falhas || 'quantidade de acordos novos diferente dos aprovados'::text;
  end if;

  select jsonb_agg(jsonb_build_object('acordo', av.numero, 'valor', av.valor_pago, 'soma', av.soma,
      'acordo_status', a.status, 'parcela', q.status, 'pagamento', g.status_conciliacao, 'fila', f.decisao,
      'mensalidades_pago', (select count(*) from public.acordos_titulos t where t.id = any(av.tits) and upper(t.situacao) = 'PAGO'),
      'mensalidades', cardinality(av.tits),
      'resp_acordo', a.operador_responsavel_email,
      'resp_acordo_ok', lower(a.operador_responsavel_email) = av.op,
      'aluno_resp_antes', al.responsavel_atual_email, 'aluno_resp_depois', an.responsavel_atual_email,
      'aluno_status', al.status_atual || ' -> ' || an.status_atual, 'aluno_saldo', al.saldo_total::text || ' -> ' || an.saldo_total::text,
      'resp_aluno_ok', (al.responsavel_atual_email is not distinct from an.responsavel_atual_email)
                       or (an.status_atual = 'QUITADO' and an.saldo_total = 0
                           and exists (select 1 from public.casos c where c.aluno_id = an.id and c.encerrado_operacional))
                       or (coalesce(al.responsavel_atual_email,'') = '' and lower(an.responsavel_atual_email) = av.op),
      'auditoria', (select count(*) from public.auditoria u where u.acao = 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO' and u.registro_id = a.id))
      order by av.numero)
    into v_itens
    from _av av
    join _al al on al.id = av.aluno
    join public.alunos an on an.id = av.aluno
    left join public.acordos a on a.numero_ulbra = av.numero and a.id not in (select id from _ac_antes)
    left join public.parcelas q on q.acordo_id = a.id
    join public.pagamentos g on g.id = av.pag
    left join public.fila_pagamento_sem_vinculo f on f.pagamento_id = av.pag;

  select count(*) into v_n from jsonb_array_elements(v_itens) i
   where not (coalesce(i ->> 'acordo_status','') = 'QUITADO' and coalesce(i ->> 'parcela','') = 'PAGO' and i ->> 'pagamento' = 'BAIXADO'
              and coalesce(i ->> 'fila','') = 'RESOLVIDO_AUTOMATICO' and (i ->> 'mensalidades_pago')::int = (i ->> 'mensalidades')::int
              and coalesce((i ->> 'resp_acordo_ok')::boolean, false) and coalesce((i ->> 'resp_aluno_ok')::boolean, false)
              and (i ->> 'auditoria')::int = 1);
  if v_n > 0 then v_falhas := v_falhas || (v_n::text || ' aprovado(s) fora do estado final esperado: ' || v_itens::text); end if;

  select count(*) into v_n from _av av where (select count(*) from public.acordos a where ltrim(a.numero_ulbra,'0') = ltrim(av.numero,'0')) <> 1;
  if v_n > 0 then v_falhas := v_falhas || (v_n::text || ' acordo(s) em duplicidade'); end if;
  select count(*) into v_n from _av av where (select count(*) from public.parcelas q where q.origem_baixa_ref = av.pag::text) <> 1;
  if v_n > 0 then v_falhas := v_falhas || (v_n::text || ' pagamento(s) com baixa diferente de 1'); end if;
  select count(*) into v_n from _av av, unnest(av.tits) tt
   where exists (select 1 from public.acordo_titulo_vinculo v join public.acordos a2 on a2.id = v.acordo_id
                  where v.titulo_id = tt and coalesce(v.ativo, true) and a2.numero_ulbra <> av.numero
                    and upper(coalesce(a2.status,'')) not in ('CANCELADO','CANCELADA'));
  if v_n > 0 then v_falhas := v_falhas || (v_n::text || ' titulo(s) em dois acordos'); end if;
  if v_pjp_a is distinct from (select md5(string_agg(g.id::text || coalesce(g.status_conciliacao,'') || coalesce(f.decisao,'') || coalesce(g.conciliacao_motivo,''), '|' order by g.id))
        from public.pagamentos g join public.fila_pagamento_sem_vinculo f on f.pagamento_id = g.id where g.status_conciliacao = 'PARCELA_JA_PAGA') then
    v_falhas := v_falhas || 'PARCELA_JA_PAGA alterada'::text;
  end if;
  if v_parc_a is distinct from (select md5(string_agg(q.id::text || coalesce(q.status,'') || coalesce(q.valor,0)::text || coalesce(q.origem_baixa_ref,''), '|' order by q.id))
        from public.parcelas q where q.acordo_id in (select id from _ac_antes) or q.acordo_id is null) then
    v_falhas := v_falhas || 'parcela preexistente alterada'::text;
  end if;
  if v_acor_a is distinct from (select md5(string_agg(a.id::text || coalesce(a.status,'') || coalesce(a.saldo,0)::text, '|' order by a.id))
        from public.acordos a where a.id in (select id from _ac_antes)) then
    v_falhas := v_falhas || 'acordo preexistente alterado'::text;
  end if;
  if v_tit_a is distinct from (select md5(string_agg(t.id::text || coalesce(t.situacao,'') || coalesce(t.status,'') || coalesce(t.acordo_id::text,''), '|' order by t.id))
        from public.acordos_titulos t where not (t.id = any(coalesce((select array_agg(u) from _av, unnest(tits) u), '{}')))) then
    v_falhas := v_falhas || 'mensalidade fora da selecao alterada'::text;
  end if;
  if v_rec_a is distinct from (select md5(string_agg(g.id::text || coalesce(g.status_conciliacao,'') || coalesce(g.aluno_id::text,'') || g.valor_pago::text || coalesce(f.decisao,''), '|' order by g.id))
        from public.pagamentos g join public.fila_pagamento_sem_vinculo f on f.pagamento_id = g.id
       where g.status_conciliacao = 'AGUARDANDO_ACORDO' and g.id not in (select pag from _av)) then
    v_falhas := v_falhas || 'pagamento recusado alterado'::text;
  end if;

  if cardinality(v_falhas) > 0 then
    raise exception 'LOTE ABORTADO, nada gravado: %', array_to_string(v_falhas, ' || ');
  end if;

  insert into public.fluxo_pagamentos_execucoes (origem, carteira_antes, carteira_depois, resultado, erro)
  values ('rollout_recuperacao_avista_lote_1', v_saldo_a, v_saldo_d,
          jsonb_build_object('rotina', v_r - 'itens', 'tempo_ms', v_ms, 'aprovados_pela_previa', (select count(*) from _av),
                             'valor_recuperado', (select sum(valor_pago) from _av), 'mensalidades_quitadas', (select sum(soma) from _av),
                             'por_aprovado', v_itens, 'itens_da_rotina', v_r -> 'itens',
                             'invariantes', 'todas ok: 0 erros, 0 duplicidade, 0 baixa dupla, 0 titulo em dois acordos, PARCELA_JA_PAGA, parcelas, acordos, mensalidades e recusados intactos'),
          null);
end;
$lote$;
