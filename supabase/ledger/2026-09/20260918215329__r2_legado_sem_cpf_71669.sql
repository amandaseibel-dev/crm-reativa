-- CONFERENCIA PRIME -- R2, pagamento legado sem CPF: pagamento 71669.
-- Autorizacao da gestao (18/09/2026) SO para os 9 pagamentos R2: o CPF do pagamento nao existe nem no registro bruto do arquivo.
-- Identidade por PROVA COMPOSTA (10 evidencias, todas obrigatorias); nome sozinho nao prova.
-- Fronteira anterior a 14/09 atravessada SO para este pagamento (pagamento_conciliar_um nele, e em mais nenhum); o corte global,
-- a regra global de CPF e a margem global nao mudam. Rota financeira real numa transacao: rejeitar o titulo na Conferencia
-- (ROTA_FINANCEIRA_PAGAMENTO) -> [origem externa | margem excepcional, quando for o caso] -> acordo a vista pelo pagamento
-- -> solicitacao encerrada. Qualquer falha desfaz o pagamento inteiro.
do $r2$
declare
  c_modo  constant text := 'EXECUCAO';
  c_lista constant jsonb := '[{"bol": "50716690001", "pag": "48fa9255-8205-4968-bbf2-f1c39195fd56", "tit": "e4886708-28f5-4b9a-9fee-2c210a7b0777", "sol": "0d9c8a4e-7ee3-45d9-93dc-e8f1b56cb1a4", "tol": 0, "margem": false, "externa": false}]'::jsonb;
  c_email constant text := 'amanda.seibel@aelbra.com.br';
  it jsonb; v_md5 text; v_pag record; v_aluno record; v_tit record; v_dec record; v_prime record;
  v_bol text; v_acordo6 text; v_nome text; v_cpf text; v_base numeric; v_soma numeric; v_prime_v numeric; v_n int;
  v_res jsonb; v_acordo uuid; v_ev jsonb; v_out jsonb := '{}'::jsonb; v_tol int; v_margem boolean; v_externa boolean;
  v_a0 bigint; v_p0 bigint; v_pp0 bigint; v_g0 bigint; v_b0 bigint; v_v0 bigint; v_rep0 bigint;
begin
  select md5(string_agg(proname || '=' || md5(prosrc), ',' order by proname)) into v_md5
    from pg_proc where pronamespace = 'public'::regnamespace and proname = any(array['_talvez_quitar_aluno','_titulo_em_confirmacao_protegido','_titulo_situacao_e_status_coerentes','_trg_auto_quitar_titulo','aluno_saldo_pendente_detalhe','assumir_caso_livre','caso_aguarda_confirmacao_financeira','caso_protegido_redistribuicao','casos_encerrar_zerados_sem_debito','casos_reavaliar_encerramento','contar_carteira_ativa','nivelar_medias_progressivo','prime_conferencia_baixar','prime_conferencia_confirmar','prime_conferencia_detectar_grupo_a','prime_conferencia_fila','prime_conferencia_rejeitar','prime_conferencia_rejeitar_lote','prime_conferencia_vincular','prime_grupo_a_candidatos','recalcular_situacao_aluno','reforcar_teto_operadores','titulo_liquidado_na_origem_e_terminal']);
  if v_md5 is distinct from 'd9e15cb291b2aa3c05f3a0f0f335f732' then raise exception 'R2_PRE: funcoes do grupo A mudaram'; end if;
  select md5(string_agg(proname || '=' || md5(prosrc), ',' order by proname)) into v_md5
    from pg_proc where pronamespace = 'public'::regnamespace
     and proname = any(array['acordo_avista_previa','acordo_avista_registrar','pagamento_autorizar_margem_excepcional','vincular_titulos_acordo','pagamento_conciliar_um']);
  if v_md5 is distinct from '098bd5fcc110691d07fbab430acec0a3' then raise exception 'R2_PRE: funcoes da rota mudaram'; end if;
  if exists (select 1 from cron.job where command ilike '%reposicao%' and active) then raise exception 'R2_PRE: reposicao nao esta pausada'; end if;
  perform set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br","sub":"52b292e4-e43e-4200-a684-b63d889d273a","role":"authenticated"}', true);

  for it in select * from jsonb_array_elements(c_lista) loop
   begin
    v_bol := it ->> 'bol'; v_tol := (it ->> 'tol')::int; v_margem := (it ->> 'margem')::boolean; v_externa := (it ->> 'externa')::boolean;

    -- ===== pre-condicoes do pagamento =====
    select p.* into v_pag from public.pagamentos p where p.id = (it ->> 'pag')::uuid;
    if v_pag.id is null or ltrim(coalesce(v_pag.numero_parcela_completo,''),'0') <> v_bol then raise exception 'R2_PRE %: pagamento nao confere', v_bol; end if;
    if v_pag.status_conciliacao is not null or exists (select 1 from public.fila_pagamento_sem_vinculo f where f.pagamento_id = v_pag.id) then
      raise exception 'R2_PRE %: pagamento nao esta mais intocado antes da fronteira', v_bol;
    end if;
    if v_pag.data_pagamento >= date '2026-09-14' then raise exception 'R2_PRE %: nao e pagamento legado', v_bol; end if;
    if v_pag.cpf is not null or coalesce(nullif(regexp_replace(coalesce(v_pag.dados ->> 'cpf',''),'\D','','g'),''),'') <> '' then
      raise exception 'R2_PRE %: o pagamento tem CPF; a prova composta nao se aplica', v_bol;
    end if;
    if exists (select 1 from public.parcelas p where p.origem_baixa_ref = v_pag.id::text)
       or exists (select 1 from public.pagamento_margem_autorizada m where m.pagamento_id = v_pag.id) then
      raise exception 'R2_PRE %: pagamento ja utilizado', v_bol;
    end if;
    v_acordo6 := ltrim(substr(v_bol, 2, 6), '0');
    if exists (select 1 from public.acordos a where ltrim(coalesce(a.numero_ulbra,''),'0') = v_acordo6) then raise exception 'R2_PRE %: ja existe acordo com esse numero', v_bol; end if;

    select a.* into v_aluno from public.alunos a where a.id = v_pag.aluno_id;
    select t.* into v_tit from public.acordos_titulos t where t.id = (it ->> 'tit')::uuid;
    select d.* into v_dec from public.prime_conferencia_decisao d where d.titulo_id = v_tit.id;
    select x.* into v_prime from public.prime_extrato x where ltrim(x.boleto,'0') = ltrim(v_tit.documento,'0') order by x.coletado_em desc limit 1;
    v_nome := translate(upper(regexp_replace(btrim(coalesce(v_pag.aluno_nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC');
    v_cpf := lpad(regexp_replace(coalesce(v_prime.cpf,''),'\D','','g'),11,'0');

    -- ===== prova composta: 10 evidencias =====
    -- 1. nome do pagamento aponta um unico aluno, e e este
    if v_nome = '' or (select count(*) from public.alunos a where translate(upper(regexp_replace(btrim(a.nome),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') = v_nome) <> 1
       or translate(upper(regexp_replace(btrim(v_aluno.nome),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') <> v_nome then
      raise exception 'R2_PROVA %: 1 nome nao aponta um unico aluno', v_bol;
    end if;
    -- 2. nenhum outro aluno plausivel: homonimo de primeiro+ultimo nome com liquidacao Prime, solicitacao do mesmo valor ou pagamento no dia
    if exists (select 1 from public.alunos a
                where a.id <> v_aluno.id
                  and split_part(translate(upper(btrim(a.nome)),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC'),' ',1) = split_part(v_nome,' ',1)
                  and regexp_replace(translate(upper(btrim(a.nome)),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC'),'^.* ','') = regexp_replace(v_nome,'^.* ','')
                  and (exists (select 1 from public.prime_conferencia_decisao d where d.aluno_id = a.id and (d.evidencia ->> 'liquidado_em')::date between v_pag.data_pagamento - 5 and v_pag.data_pagamento + 5)
                       or exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.aluno_id = a.id::text and round(s.valor_informado,2) = round(v_pag.valor_pago,2))
                       or exists (select 1 from public.pagamentos q where q.aluno_id = a.id and q.data_pagamento = v_pag.data_pagamento))) then
      raise exception 'R2_PROVA %: 2 ha outro aluno plausivel', v_bol;
    end if;
    -- 3. titulo na Prime com CPF valido (digitos verificadores)
    if v_prime.boleto is null or v_cpf !~ '^\d{11}$' or v_cpf ~ '^(\d)\1{10}$'
       or ((select sum(substr(v_cpf,i,1)::int*(11-i)) from generate_series(1,9) i)*10 % 11 % 10) <> substr(v_cpf,10,1)::int
       or ((select sum(substr(v_cpf,i,1)::int*(12-i)) from generate_series(1,10) i)*10 % 11 % 10) <> substr(v_cpf,11,1)::int then
      raise exception 'R2_PROVA %: 3 CPF do titulo na Prime invalido', v_bol;
    end if;
    -- 4. esse CPF identifica um unico aluno, e e este
    if (select count(*) from public.alunos a where lpad(regexp_replace(coalesce(a.cpf,''),'\D','','g'),11,'0') = v_cpf) <> 1
       or lpad(regexp_replace(coalesce(v_aluno.cpf,''),'\D','','g'),11,'0') <> v_cpf then
      raise exception 'R2_PROVA %: 4 CPF do titulo nao aponta so este aluno', v_bol;
    end if;
    -- 5. matricula do arquivo coerente com a matricula Prime do titulo
    if v_pag.matricula is not null and v_prime.matricula is not null and v_pag.matricula <> v_prime.matricula then
      raise exception 'R2_PROVA %: 5 matricula do pagamento diverge da Prime', v_bol;
    end if;
    -- 6. acordo do boleto no contexto deste aluno: coluna de titulo concorda com o boleto, ninguem mais usa esse acordo,
    --    e ha solicitacao financeira deste aluno com exatamente o valor pago
    if ltrim(regexp_replace(coalesce(v_pag.titulo_numero,''),'\D','','g'),'0') <> v_acordo6
       or exists (select 1 from public.pagamentos q where ltrim(q.numero_parcela_completo,'0') ~ '^5\d{10}$'
                    and ltrim(substr(ltrim(q.numero_parcela_completo,'0'),2,6),'0') = v_acordo6 and q.aluno_id is distinct from v_aluno.id)
       or (select count(*) from public.solicitacoes_confirmacao_pagamento s where s.aluno_id = v_aluno.id::text and s.status = 'AGUARDANDO_CONFIRMACAO') <> 1
       or not exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.id = (it ->> 'sol')::uuid and s.aluno_id = v_aluno.id::text
                        and s.status = 'AGUARDANDO_CONFIRMACAO' and round(s.valor_informado,2) = round(v_pag.valor_pago,2)) then
      raise exception 'R2_PROVA %: 6 acordo do boleto fora do contexto do aluno', v_bol;
    end if;
    -- 7. valor e datas compativeis
    v_base := v_pag.valor_pago - coalesce(v_pag.valor_honorario,0);
    v_soma := round(coalesce(v_tit.valor_cobranca_ajustado, v_tit.saldo_corrigido, v_tit.valor_em_aberto, v_tit.valor_original, 0), 2);
    v_prime_v := greatest(coalesce(v_prime.valor_pago,0), coalesce(v_prime.valor_bruto,0));
    if v_prime.liquidado_em is null or (v_dec.evidencia ->> 'liquidado_em')::date <> v_prime.liquidado_em
       or v_prime.liquidado_em not between v_pag.data_pagamento - v_tol and v_pag.data_pagamento
       or abs(coalesce(v_pag.valor_honorario,0) / nullif(v_base,0) - 0.08) > 0.0075
       or v_base < v_soma - 0.05
       or (v_pag.valor_pago > v_soma * 1.15 + 0.005 and not (v_margem and v_base <= v_prime_v + 0.005))
       or (v_pag.valor_pago <= v_soma * 1.15 + 0.005 and v_margem) then
      raise exception 'R2_PROVA %: 7 valor ou data incompativel', v_bol;
    end if;
    -- 8. nenhum outro pagamento explica o titulo (so o do acordo 069429 do 71606, que cobre outro titulo, e aceito)
    if exists (select 1 from public.pagamentos q
                where (q.aluno_id = v_aluno.id or translate(upper(regexp_replace(btrim(coalesce(q.aluno_nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') = v_nome)
                  and q.id <> v_pag.id and q.data_pagamento between v_pag.data_pagamento - 30 and v_pag.data_pagamento + 30
                  and not (v_bol = '50716060001' and ltrim(q.numero_parcela_completo,'0') = '50694290001')) then
      raise exception 'R2_PROVA %: 8 outro pagamento pode explicar o titulo', v_bol;
    end if;
    -- 9. nenhum acordo cobre o titulo
    if v_tit.acordo_id is not null or exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = v_tit.id and coalesce(v.ativo, true)) then
      raise exception 'R2_PROVA %: 9 ha acordo cobrindo o titulo', v_bol;
    end if;
    -- 10. titulo EM_CONFIRMACAO e decisao PENDENTE, do mesmo aluno
    if v_tit.aluno_id <> v_aluno.id or v_tit.situacao <> 'EM_CONFIRMACAO' or v_dec.decisao <> 'PENDENTE' or v_tit.origem_liquidacao is not null then
      raise exception 'R2_PROVA %: 10 titulo ou decisao fora do estado', v_bol;
    end if;

    v_ev := jsonb_build_object(
      '1_nome_unico', true, '2_sem_homonimo_plausivel', true, '3_cpf_prime_valido', true, '4_cpf_aponta_o_aluno', true,
      '5_matricula', case when v_pag.matricula is not null and v_prime.matricula is not null then 'igual a Prime' else 'indisponivel' end,
      '6_acordo_boleto', v_acordo6, '6_titulo_numero_concorda', true, '6_solicitacao_mesmo_valor', it ->> 'sol',
      '7_liquidacao_prime', v_prime.liquidado_em, '7_data_pagamento', v_pag.data_pagamento,
      '7_diferenca_dias', v_pag.data_pagamento - v_prime.liquidado_em,
      '7_valor_pago', v_pag.valor_pago, '7_honorario', v_pag.valor_honorario, '7_base', v_base, '7_valor_titulo', v_soma,
      '7_valor_prime', v_prime_v, '7_razao_pago_titulo', round(v_pag.valor_pago / v_soma, 4),
      '8_sem_outro_pagamento', true, '9_sem_acordo_no_titulo', true, '10_titulo_pendente', true);

    select count(*) into v_a0 from public.acordos;
    select count(*) into v_p0 from public.parcelas;
    select count(*) filter (where status = 'PAGO') into v_pp0 from public.parcelas;
    select count(*) into v_g0 from public.pagamentos;
    select count(*) into v_b0 from public.baixas_pagamento;
    select count(*) into v_v0 from public.acordo_titulo_vinculo where coalesce(ativo, true);
    select coalesce(max(id),0) into v_rep0 from public.reposicao_carteira_fila;

    -- ===== autorizacao auditavel deste pagamento =====
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values (c_email, 'AUTORIZACAO_GESTAO_PAGAMENTO_LEGADO_SEM_CPF', 'pagamentos', v_pag.id,
            jsonb_build_object('pagamento_id', v_pag.id, 'boleto', v_bol, 'nome_origem', v_pag.aluno_nome, 'aluno_id', v_aluno.id,
                               'cpf_validado_pelo_titulo_prime', v_cpf, 'titulo_prime', v_tit.documento, 'acordo_do_boleto', v_acordo6,
                               'evidencias', v_ev, 'autorizado_em', now(), 'autorizado_por', c_email,
                               'escopo', 'so os 9 pagamentos R2; fronteira de 14/09 atravessada so para este pagamento; regras globais inalteradas'));

    -- ===== fronteira: o motor oficial so neste pagamento =====
    v_res := public.pagamento_conciliar_um(v_pag.id, true);
    if coalesce(v_res ->> 'status','') <> 'AGUARDANDO_ACORDO'
       or not exists (select 1 from public.fila_pagamento_sem_vinculo f where f.pagamento_id = v_pag.id and f.decisao is null) then
      raise exception 'R2 %: o motor nao deixou o pagamento aguardando acordo (%)', v_bol, v_res;
    end if;

    -- ===== rota financeira =====
    v_res := public.prime_conferencia_rejeitar(v_tit.id, 'ROTA_FINANCEIRA_PAGAMENTO: Conferencia Prime, gestao 18/09/2026. Pagamento legado sem CPF '
                                               || v_bol || ' (prova composta de identidade); acordo a vista registrado pelo pagamento na mesma transacao.');
    if coalesce(v_res ->> 'decisao','') <> 'REJEITADO' then raise exception 'R2 %: rejeicao falhou (%)', v_bol, v_res; end if;

    if v_externa then
      v_res := public.pagamento_autorizar_origem_externa(v_pag.id,
        'Pagamento legado sem CPF (R2) com operador de origem externa sem cadastro no CRM; credito individual nao atribuido. Gestao 18/09/2026.');
      if not coalesce((v_res ->> 'ok')::boolean, false) or coalesce((v_res ->> 'ja_autorizado')::boolean, false) then
        raise exception 'R2 %: origem externa nao autorizada (%)', v_bol, v_res;
      end if;
    end if;
    if v_margem then
      v_res := public.pagamento_autorizar_margem_excepcional(v_pag.id,
        'Autorizado pela Amanda em 18/09/2026 (classe A/B): base entre o valor das mensalidades e o corrigido do Prime. R2, pagamento legado sem CPF.');
      if not coalesce((v_res ->> 'ok')::boolean, false) or coalesce((v_res ->> 'ja_autorizado')::boolean, false)
         or not exists (select 1 from public.pagamento_margem_autorizada m where m.pagamento_id = v_pag.id and m.titulo_ids = array[v_tit.id]) then
        raise exception 'R2 %: margem nao autorizada (%)', v_bol, v_res;
      end if;
    end if;

    v_res := public.acordo_avista_registrar(v_pag.id, array[v_tit.id], true);
    if not coalesce((v_res ->> 'ok')::boolean, false) or coalesce(v_res ->> 'modo','') <> 'CONFIRMADO' then
      raise exception 'R2 %: registro recusado (%)', v_bol, coalesce(v_res -> 'bloqueios', v_res);
    end if;
    v_acordo := (v_res ->> 'acordo_id')::uuid;

    -- solicitacao: fecha sozinha quando o aluno quita; com outra divida, confirma pela funcao oficial (nao quita ninguem)
    if (select status from public.solicitacoes_confirmacao_pagamento where id = (it ->> 'sol')::uuid) = 'AGUARDANDO_CONFIRMACAO' then
      v_res := public.confirmar_pagamento_solicitacao((it ->> 'sol')::uuid,
        'Pagamento ' || v_bol || ' confirmado pela rota financeira (acordo a vista registrado pelo pagamento).');
      if coalesce((v_res ->> 'quitou')::boolean, true) then raise exception 'R2 %: confirmar a solicitacao quitaria o aluno (%)', v_bol, v_res; end if;
    end if;

    -- ===== travas de saida =====
    if (select status_conciliacao from public.pagamentos where id = v_pag.id) <> 'BAIXADO' then raise exception 'R2_POS %: pagamento nao BAIXADO', v_bol; end if;
    if not exists (select 1 from public.acordos a where a.id = v_acordo and a.status = 'QUITADO' and ltrim(coalesce(a.numero_ulbra,''),'0') = v_acordo6 and a.aluno_id = v_aluno.id) then
      raise exception 'R2_POS %: acordo errado', v_bol;
    end if;
    if v_externa and (select operador_responsavel_email from public.acordos where id = v_acordo) is not null then
      raise exception 'R2_POS %: origem externa recebeu credito de operador', v_bol;
    end if;
    if (select count(*) from public.parcelas p where p.acordo_id = v_acordo) <> 1
       or (select count(*) from public.parcelas p where p.acordo_id = v_acordo and p.status = 'PAGO' and p.origem_baixa_ref = v_pag.id::text) <> 1
       or (select count(*) from public.parcelas p where p.origem_baixa_ref = v_pag.id::text) <> 1 then
      raise exception 'R2_POS %: parcela fora do esperado', v_bol;
    end if;
    if not exists (select 1 from public.acordos_titulos t join public.prime_conferencia_decisao d on d.titulo_id = t.id
                    where t.id = v_tit.id and t.situacao = 'PAGO' and t.status = 'quitada' and t.acordo_id = v_acordo and t.origem_liquidacao is null
                      and d.decisao = 'REJEITADO' and d.motivo like 'ROTA_FINANCEIRA_PAGAMENTO%') then
      raise exception 'R2_POS %: titulo nao ficou PAGO no acordo', v_bol;
    end if;
    if (select count(*) from public.acordo_titulo_vinculo v join public.acordos a on a.id = v.acordo_id
         where v.titulo_id = v_tit.id and coalesce(v.ativo, true) and a.status not in ('CANCELADO','CANCELADA')) <> 1 then
      raise exception 'R2_POS %: titulo em mais de um acordo', v_bol;
    end if;
    if (select status from public.solicitacoes_confirmacao_pagamento where id = (it ->> 'sol')::uuid) <> 'PAGAMENTO_CONFIRMADO' then
      raise exception 'R2_POS %: solicitacao nao encerrada', v_bol;
    end if;
    if (select count(*) from public.acordos) <> v_a0 + 1 or (select count(*) from public.parcelas) <> v_p0 + 1
       or (select count(*) filter (where status = 'PAGO') from public.parcelas) <> v_pp0 + 1
       or (select count(*) from public.pagamentos) <> v_g0 or (select count(*) from public.baixas_pagamento) <> v_b0
       or (select count(*) from public.acordo_titulo_vinculo where coalesce(ativo, true)) <> v_v0 + 1 then
      raise exception 'R2_POS %: contadores fora do esperado', v_bol;
    end if;
    if exists (select origem_baixa_ref from public.parcelas where origem_baixa_ref is not null and status = 'PAGO' group by 1 having count(*) > 1) then
      raise exception 'R2_POS %: pagamento usado em duas parcelas', v_bol;
    end if;

    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values (c_email, 'CONFERENCIA_PRIME_ROTA_FINANCEIRA_PAGAMENTO', 'pagamentos', v_pag.id,
            jsonb_build_object('boleto', v_bol, 'grupo', 'R2', 'pagamento_legado_sem_cpf', true, 'pagamento_id', v_pag.id, 'acordo_id', v_acordo,
                               'titulo_ids', jsonb_build_array(v_tit.id), 'valor_titulos', v_soma, 'valor_pago', v_pag.valor_pago,
                               'diferenca_dias_prime_pagamento', v_pag.data_pagamento - v_prime.liquidado_em,
                               'margem_excepcional', v_margem, 'origem_externa', v_externa,
                               'diferenca_percentual', round((v_pag.valor_pago / v_soma - 1) * 100, 2),
                               'solicitacao_confirmada', it ->> 'sol',
                               'sequencia', 'prova composta -> fronteira so neste pagamento -> rejeitar (ROTA_FINANCEIRA_PAGAMENTO) -> acordo a vista pelo pagamento -> solicitacao'));

    v_out := v_out || jsonb_build_object(v_bol, jsonb_build_object('ok', true, 'acordo', (select numero_acordo from public.acordos where id = v_acordo),
               'aluno_depois', (select situacao_operacional from public.alunos where id = v_aluno.id),
               'reposicao_nova', (select count(*) from public.reposicao_carteira_fila where id > v_rep0)));
    if c_modo = 'SIMULACAO' then raise exception 'DESFAZ'; end if;
   exception when others then
    if c_modo = 'SIMULACAO' then
      if sqlerrm <> 'DESFAZ' then v_out := v_out || jsonb_build_object(v_bol, jsonb_build_object('ok', false, 'erro', left(sqlerrm, 300))); end if;
    else
      raise;
    end if;
   end;
  end loop;

  if c_modo = 'SIMULACAO' then raise exception 'SIMULACAO %', v_out::text; end if;
end;
$r2$;
