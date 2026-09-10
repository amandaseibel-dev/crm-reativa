-- NIVELAMENTO AUTOMATICO DA BASE DA GESTAO (pedido de 10/09/2026)
--
-- Debito parado na carteira da gestao nao e cobrado por ninguem. A partir de
-- agora, todo caso na base da gestao com debito vencido ha mais de N dias
-- (parcela de acordo OU mensalidade) sai automaticamente para os operadores,
-- dando mais para quem tem MENOS -- nivelamento por quantidade, na regra que a
-- gestao escolheu.
--
-- Duas contagens diferentes, porque sao duas filas diferentes de trabalho:
--   * caso com acordo   -> nivela pela quantidade de ACORDOS ATIVOS do operador
--   * caso so mensalidade -> nivela pela quantidade de CASOS ACIONAVEIS
--
-- NUNCA sai daqui: caso com link de pagamento aberto, baixa aguardando,
-- confirmacao de pagamento pendente ou marcado "nao acionar" -- alguem esta no
-- meio de uma tratativa e mover quebraria o atendimento.
create or replace function public.nivelamento_automatico_gestao(
  p_dias int default 10,
  p_aplicar boolean default true,
  p_origens text[] default array['amanda.seibel@aelbra.com.br']
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res jsonb; v_movidos int := 0; v_caso record; v_dest record;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para nivelar a base da gestão.';
  end if;
  p_dias := greatest(coalesce(p_dias, 10), 0);

  -- Elegiveis: debito vencido ha mais de p_dias, sem tratativa em curso.
  create temp table _eleg on commit drop as
  select c.id caso_id, c.aluno_id, c.chave_unificacao, coalesce(c.nome, c.nome_aluno) nome,
         c.cpf, c.operador_email de_email,
         lpad(regexp_replace(coalesce(c.cpf_limpo,''), '\D', '', 'g'), 11, '0') cpfn,
         exists (select 1 from public.acordos a where a.cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''), '\D','','g'),11,'0') and a.status = 'ATIVO') tem_acordo,
         round(coalesce(s.saldo_total,0),2) valor
    from public.casos c
    join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
   where c.operador_email = any(p_origens)
     and coalesce(s.saldo_total,0) > 0
     and not coalesce(c.nao_acionar, false)
     and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada)
     -- tratativa em curso fica onde esta
     and not exists (select 1 from public.links_pagamento l where l.aluno_cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0')
                       and l.status in ('AGUARDANDO_BAIXA','LINK_ENVIADO_AO_ALUNO','LINK_PRONTO_PARA_ENVIO'))
     and not exists (select 1 from public.baixas_pagamento b where b.aluno_cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0')
                       and b.status_baixa = 'AGUARDANDO_BAIXA')
     and not exists (select 1 from public.solicitacoes_confirmacao_pagamento sc where sc.aluno_cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0')
                       and sc.status = 'AGUARDANDO_CONFIRMACAO')
     -- e o que define o caso: existe parcela ou mensalidade vencida ha mais de p_dias
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

  -- Carga atual de cada operador ativo, nas duas contagens.
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

  -- Distribuicao "enche o mais vazio primeiro": a cada caso, quem tem a menor
  -- carga leva. E o nivelamento por quantidade, caso a caso, e sem precisar
  -- calcular alvo -- o proprio laco converge para o nivel comum.
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
$$;

revoke all on function public.nivelamento_automatico_gestao(int, boolean, text[]) from public, anon, authenticated;
grant execute on function public.nivelamento_automatico_gestao(int, boolean, text[]) to authenticated;

comment on function public.nivelamento_automatico_gestao(int, boolean, text[]) is
  'Tira da base da gestão todo caso com débito vencido há mais de N dias (parcela de acordo ou mensalidade) e distribui para os operadores, dando mais para quem tem menos. p_aplicar=false simula. Roda diariamente pelo cron nivelamento_automatico_gestao.';

-- Roda todo dia as 06:20 de Brasilia (09:20 UTC), 10 minutos depois do vigia
-- de invariantes, para nao disputar a janela com ele.
select cron.schedule('nivelamento_automatico_gestao', '20 9 * * *',
  $cron$select public.nivelamento_automatico_gestao(10, true)$cron$);
