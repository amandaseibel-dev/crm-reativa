-- ROLLBACK de 20260920140000_protecao_confirmacao_financeira_por_aluno.
-- Restaura EXATAMENTE as definicoes de producao lidas em 20/09/2026, antes da mudanca:
--   caso_protegido_redistribuicao  md5(prosrc)=11caab2c73df87ad68e801075bd95fe3  md5(pg_get_functiondef)=c497631ffeec5e06bce6ddcc974af48b
--   nivelamento_automatico_gestao  md5(prosrc)=af551b61fd4d419bc8a49ba8344b7f2c  md5(pg_get_functiondef)=7ae72fea9af90386aee288c189f9f12a
-- Nenhum dado e tocado (so duas funcoes).
begin;

CREATE OR REPLACE FUNCTION public.caso_protegido_redistribuicao(p_cpf_limpo text, p_status_acionamento text, p_nao_acionar boolean, p_status_financeiro text DEFAULT NULL::text, p_valor_pago numeric DEFAULT NULL::numeric, p_quitado_em date DEFAULT NULL::date, p_valor_quitado numeric DEFAULT NULL::numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_status_norm text := public.normalizar_status_acionamento(p_status_acionamento);
  v_status_fin_norm text := public.normalizar_status_acionamento(p_status_financeiro);
  v_cpf text := lpad(regexp_replace(coalesce(p_cpf_limpo,''), '\D', '', 'g'), 11, '0');
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'];
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL'];
begin
  if coalesce(p_nao_acionar, false) then return true; end if;

  if v_status_norm = any(bloq) or v_status_fin_norm = any(bloq) then
    return true;
  end if;

  -- Caso cujo unico saldo esta em titulo aguardando a Conferencia Prime: nao
  -- ocupa vaga (teto, reposicao, nivelamento), nao e redistribuido e nao e
  -- solto pela fidelizacao -- o responsavel fica para quando houver decisao.
  -- (o aluno e achado pelo CPF normalizado da ficha -- indice
  -- idx_alunos_cpf_normalizado; o CPF gravado no titulo pode divergir)
  if v_cpf <> '00000000000' and v_cpf <> '' and exists (
       select 1 from public.alunos al
        where lpad(regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g'), 11, '0') = v_cpf
          and exists (select 1 from public.acordos_titulos t
                       where t.aluno_id = al.id
                         and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO')
          and public.caso_aguarda_confirmacao_financeira(al.id)) then
    return true;
  end if;

  if v_cpf = '00000000000' or v_cpf = '' then
    null;
  elsif exists (select 1 from public.acordos a where a.cpf = v_cpf and a.status = 'ATIVO')
     or exists (select 1 from public.baixas_pagamento b where b.aluno_cpf = v_cpf and b.status_baixa = 'AGUARDANDO_BAIXA')
     -- pagamento em transito: protege sempre
     or exists (select 1 from public.links_pagamento l where l.aluno_cpf = v_cpf and l.status = 'AGUARDANDO_BAIXA')
     -- link vivo: protege por um dia
     or exists (select 1 from public.links_pagamento l
                 where l.aluno_cpf = v_cpf
                   and l.status in ('LINK_ENVIADO_AO_ALUNO','LINK_PRONTO_PARA_ENVIO')
                   and coalesce(l.enviado_ao_aluno_em, l.enviado_em, l.criado_em)::date >= current_date - 1)
     or exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.aluno_cpf = v_cpf and s.status = 'AGUARDANDO_CONFIRMACAO')
  then
    return true;
  end if;

  if (v_status_norm = any(quit) or v_status_fin_norm = any(quit)
      or coalesce(p_valor_pago,0) > 0 or p_quitado_em is not null or coalesce(p_valor_quitado,0) > 0)
     and public.saldo_titulos_aberto(v_cpf) = 0
  then
    return true;
  end if;

  if v_status_norm in (
    'ACORDO FECHADO','ACORDO EM ANDAMENTO','EM NEGOCIACAO',
    'AGUARDANDO PAGAMENTO','AGUARDANDO FINANCEIRO','EMAIL ENVIADO AO FINANCEIRO','E MAIL ENVIADO FINANC',
    'LINK CARTAO ENVIADO','PAGO PARCIAL','VALORES ENVIADOS','PROPOSTA ENVIADA','PROPOSTA DE EXCECAO',
    'TERMO ENVIADO','TERMO RECEBIDO','EM TRATATIVA','RETORNO AGENDADO'
  ) then
    return true;
  end if;

  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION public.nivelamento_automatico_gestao(p_dias integer DEFAULT 10, p_aplicar boolean DEFAULT true, p_origens text[] DEFAULT ARRAY['amanda.seibel@aelbra.com.br'::text])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_res jsonb; v_movidos int := 0; v_caso record; v_dest record;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para nivelar a base da gestão.';
  end if;
  p_dias := greatest(coalesce(p_dias, 10), 0);

  create temp table _eleg on commit drop as
  select c.id caso_id, c.aluno_id, c.chave_unificacao, coalesce(c.nome, c.nome_aluno) nome,
         c.cpf, c.operador_email de_email,
         exists (select 1 from public.acordos a where a.cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''), '\D','','g'),11,'0') and a.status = 'ATIVO') tem_acordo,
         round(coalesce(s.saldo_total,0),2) valor
    from public.casos c
    join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
   where c.operador_email = any(p_origens)
     and coalesce(s.saldo_total,0) > 0
     and not coalesce(c.nao_acionar, false)
     and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada)
     and not exists (select 1 from public.links_pagamento l where l.aluno_cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0')
                       and l.status in ('AGUARDANDO_BAIXA','LINK_ENVIADO_AO_ALUNO','LINK_PRONTO_PARA_ENVIO'))
     and not exists (select 1 from public.baixas_pagamento b where b.aluno_cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0')
                       and b.status_baixa = 'AGUARDANDO_BAIXA')
     and not exists (select 1 from public.solicitacoes_confirmacao_pagamento sc where sc.aluno_cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0')
                       and sc.status = 'AGUARDANDO_CONFIRMACAO')
     and (
       exists (select 1 from public.acordos a join public.parcelas pp on pp.acordo_id = a.id
                where a.cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0') and a.status = 'ATIVO'
                  and upper(coalesce(pp.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
                  and pp.vencimento < current_date - p_dias)
       or exists (select 1 from public.acordos_titulos t
                   where t.aluno_id = c.aluno_id and upper(coalesce(t.situacao,'')) = 'ABERTO'
                     and lower(coalesce(t.status,'')) = 'em_aberto' and t.acordo_id is null
                     and t.vencimento < current_date - p_dias)
     );

  if not exists (select 1 from _eleg) then
    return jsonb_build_object('dias', p_dias, 'elegiveis', 0, 'movidos', 0,
                              'mensagem', 'Nada vencido além de ' || p_dias || ' dias na base da gestão.');
  end if;

  create temp table _op on commit drop as
  select u.email, u.nome,
         (select count(*) from public.acordos a
            join public.casos c2 on lpad(regexp_replace(coalesce(c2.cpf_limpo,''),'\D','','g'),11,'0') = a.cpf
           where a.status = 'ATIVO' and c2.operador_email = u.email)::int carga_acordo,
         (select count(*) from public.casos c3
            join public.calibragem_saldo_aluno s3 on s3.aluno_id = c3.aluno_id
           where c3.operador_email = u.email and coalesce(s3.saldo_total,0) > 0
             and not public.caso_encerrado_operacional(c3.cpf_limpo, c3.status_atual, c3.status_acionamento, c3.status_financeiro, c3.status_jornada)
             and not public.caso_protegido_redistribuicao(c3.cpf_limpo, c3.status_acionamento, c3.nao_acionar,
                   c3.status_financeiro, c3.valor_pago, c3.quitado_em, c3.valor_quitado))::int carga_caso
    from public.usuarios u
   where u.ativo and u.perfil = 'operador' and not (u.email = any(p_origens));
  if not exists (select 1 from _op) then
    raise exception 'Nenhum operador ativo para receber o nivelamento.';
  end if;

  alter table _eleg add column para_email text, add column para_nome text;

  create temp table _fila on commit drop as
    select caso_id, tem_acordo from _eleg order by tem_acordo desc, valor desc, caso_id;

  for v_caso in select * from _fila loop
    if v_caso.tem_acordo then
      select * into v_dest from _op order by carga_acordo asc, carga_caso asc, email limit 1;
      update _op set carga_acordo = carga_acordo + 1, carga_caso = carga_caso + 1 where email = v_dest.email;
    else
      select * into v_dest from _op order by carga_caso asc, carga_acordo asc, email limit 1;
      update _op set carga_caso = carga_caso + 1 where email = v_dest.email;
    end if;
    update _eleg set para_email = v_dest.email, para_nome = v_dest.nome where caso_id = v_caso.caso_id;
  end loop;

  if p_aplicar then
    perform set_config('calibragem.bypass_teto', 'on', true);
    update public.casos c
       set operador_email = e.para_email, operador_nome = e.para_nome, operador = upper(coalesce(e.para_nome,''))
      from _eleg e where c.id = e.caso_id and e.para_email is not null;
    get diagnostics v_movidos = row_count;

    insert into public.historico_operadores_alunos(aluno_id, chave_unificacao, nome_aluno, cpf_referencia, acao,
      operador_nome, operador_email, operador_anterior_email, observacao, criado_em)
    select e.aluno_id, e.chave_unificacao, e.nome, e.cpf, 'NIVELAMENTO_AUTOMATICO_GESTAO',
      e.para_nome, e.para_email, e.de_email,
      'Débito vencido há mais de ' || p_dias || ' dias na base da gestão: distribuído automaticamente para quem tinha menos.',
      now()
    from _eleg e where e.para_email is not null;
  end if;

  select jsonb_build_object(
    'dias', p_dias, 'aplicado', p_aplicar,
    'elegiveis', (select count(*) from _eleg),
    'movidos', v_movidos,
    'com_acordo', (select count(*) from _eleg where tem_acordo),
    'so_mensalidade', (select count(*) from _eleg where not tem_acordo),
    'valor', (select round(sum(valor),2) from _eleg),
    'destino', (select coalesce(jsonb_agg(jsonb_build_object('operador', para_nome, 'casos', q, 'valor', v) order by q desc),'[]')
                  from (select para_nome, count(*) q, round(sum(valor),2) v from _eleg where para_email is not null group by para_nome) t),
    'carga_depois', (select coalesce(jsonb_agg(jsonb_build_object('operador', nome, 'acordos', carga_acordo, 'casos', carga_caso) order by carga_acordo desc),'[]') from _op)
  ) into v_res;
  return v_res;
end;
$function$;

do $prova$
begin
  if md5(pg_get_functiondef('public.caso_protegido_redistribuicao(text,text,boolean,text,numeric,date,numeric)'::regprocedure)) <> 'c497631ffeec5e06bce6ddcc974af48b' then
    raise exception 'rollback nao restaurou caso_protegido_redistribuicao';
  end if;
  if md5(pg_get_functiondef('public.nivelamento_automatico_gestao(integer,boolean,text[])'::regprocedure)) <> '7ae72fea9af90386aee288c189f9f12a' then
    raise exception 'rollback nao restaurou nivelamento_automatico_gestao';
  end if;
end $prova$;

commit;
