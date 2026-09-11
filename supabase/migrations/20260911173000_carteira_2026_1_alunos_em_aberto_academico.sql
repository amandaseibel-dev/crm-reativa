-- ============================================================================
-- ALUNOS 2026/1 EM ABERTO — situação acadêmica (complemento da Visão Executiva)
-- ----------------------------------------------------------------------------
-- Pergunta da Diretoria: dos alunos que ainda têm pendência de 2026/1, quantos
-- podem voltar a estudar e em que situação estão?
--
-- "Em aberto" = o que a cobrança ainda não converteu (inadimplência confirmada
-- + em validação). Quem negociou está regularizado e fica de fora — é
-- exatamente o que permite matricular. Conta por CPF ÚNICO, somando todos os
-- títulos daquele CPF.
--
-- MATRICULADO NÃO É CATEGORIA NORMAL (regra da Amanda, 11/09/2026): o aluno só
-- efetiva matrícula com a ficha financeira regularizada. CPF com dívida 2026/1
-- aberta E contrato 2026/2 confirmado é EXCEÇÃO — existe o caso conhecido de
-- matrícula por determinação judicial, mas o painel NÃO carimba ninguém de
-- judicial: mostra a exceção e abre o detalhe para conferência individual.
--
-- FONTE (precedência da casa): o fato "matriculou em 2026/2" é do PRIME
-- (prime_contratos) e nada do CRM o sobrepõe. Formado/Trancado/Evadido o Prime
-- não expressa — prime_alunos_sync está vazia e o contrato só tem
-- Confirmado/Aberto/Anulado/Cancelado — então aí entra a situação acadêmica do
-- CRM, e a linha vai marcada com a fonte, para ninguém confundir.
--
-- NÃO altera nada da efetividade: só lê a classificação já publicada. Aditivo.
-- Reversível: drop das duas funções.
--
-- Medido em PROD 11/09/2026 — 2.669 CPFs, R$ 10.494.735,19 em aberto:
--   Iniciou matrícula 2026/2 e não concluiu  1.421 CPFs (53,2%)  R$ 6.725.991,82
--   Evadido                                    281 CPFs (10,5%)  R$   987.813,44
--   Não iniciou matrícula 2026/2               274 CPFs (10,3%)  R$   225.821,00
--   Matrícula 2026/2 cancelada / anulada       220 CPFs  (8,2%)  R$ 1.054.941,07
--   Exceção | Matrícula com pendência          198 CPFs  (7,4%)  R$   996.428,26
--   Trancado                                   171 CPFs  (6,4%)  R$   440.632,21
--   Formado                                     52 CPFs  (1,9%)  R$    14.121,22
--   Sem informação acadêmica identificada       50 CPFs  (1,9%)  R$    47.065,76
--   Outros status                                2 CPFs  (0,1%)  R$     1.920,41
-- ============================================================================
begin;

create or replace function public.carteira_2026_1_academico()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  drop table if exists _ab;
  create temp table _ab on commit drop as
  with c as (select * from public.carteira_2026_1_classificar()),
  aberto as (
    select cpf, (array_agg(aluno_id))[1] aluno_id, round(sum(inadimplencia + em_validacao),2) em_aberto
      from c group by cpf having sum(inadimplencia + em_validacao) > 0.01
  ),
  contrato as (
    select lpad(regexp_replace(coalesce(cpf,''),'\D','','g'),11,'0') cpf,
           bool_or(status = 'Confirmado') confirmado,
           bool_or(status = 'Aberto') iniciou,
           bool_or(status in ('Anulado','Cancelado')) anulado
      from public.prime_contratos
     where valid_from >= date '2026-07-01' and valid_from < date '2027-01-01'
     group by 1
  )
  select a.cpf, a.aluno_id, a.em_aberto, al.nome, al.situacao_academica,
         ct.confirmado, ct.iniciou, ct.anulado,
         case
           when ct.confirmado then 'Exceção | Matrícula com pendência'
           when ct.iniciou    then 'Iniciou matrícula 2026/2 e não concluiu'
           when ct.anulado    then 'Matrícula 2026/2 cancelada / anulada'
           when al.situacao_academica in ('Formado','Concluído') then 'Formado'
           when al.situacao_academica in ('Trancado','Trancamento Institucional') then 'Trancado'
           when al.situacao_academica in ('Desvinculado','Cancelado','Cancelamento Institucional',
                                          'Saída por Transferência','Transferência Interna','Falecido')
                then 'Evadido'
           when al.situacao_academica in ('Término do Contrato','Aguardando Matrícula','Matriculado Curso Normal')
                then 'Não iniciou matrícula 2026/2'
           when coalesce(al.situacao_academica,'') <> '' then 'Outros status'
           else 'Sem informação acadêmica identificada'
         end categoria,
         case when ct.cpf is not null then 'Prime (contrato 2026/2)'
              when coalesce(al.situacao_academica,'') <> '' then 'CRM (o Prime não expressa este status)'
              else 'sem fonte' end fonte
    from aberto a
    left join public.alunos al on al.id = a.aluno_id
    left join contrato ct on ct.cpf = a.cpf;

  select jsonb_build_object(
    'gerado_em', now(),
    'total', jsonb_build_object(
      'cpfs', (select count(*) from _ab),
      'valor', (select round(coalesce(sum(em_aberto),0),2) from _ab)
    ),
    'categorias', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'categoria', categoria, 'cpfs', cpfs, 'valor', valor,
               'pct_cpfs', pct, 'fonte', fonte) order by ordem, valor desc), '[]'::jsonb)
        from (
          select categoria, max(fonte) fonte, count(*) cpfs, round(sum(em_aberto),2) valor,
                 round(100.0*count(*)/nullif((select count(*) from _ab),0),1) pct,
                 case categoria when 'Exceção | Matrícula com pendência' then 0
                                when 'Iniciou matrícula 2026/2 e não concluiu' then 1
                                when 'Não iniciou matrícula 2026/2' then 2
                                when 'Trancado' then 3
                                when 'Matrícula 2026/2 cancelada / anulada' then 4
                                when 'Evadido' then 5
                                when 'Formado' then 6
                                when 'Outros status' then 7 else 8 end ordem
            from _ab group by categoria
        ) x
    )
  ) into v_out;
  return v_out;
end; $$;
revoke all on function public.carteira_2026_1_academico() from public, anon;
grant execute on function public.carteira_2026_1_academico() to authenticated;

create or replace function public.carteira_2026_1_academico_detalhe(
  p_categoria text, p_limite int default 200, p_offset int default 0
) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_out jsonb; v_total int; v_valor numeric;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  p_limite := least(greatest(coalesce(p_limite,200),1), 500);
  p_offset := greatest(coalesce(p_offset,0), 0);

  perform public.carteira_2026_1_academico();   -- monta _ab nesta transação

  select count(*), round(coalesce(sum(em_aberto),0),2) into v_total, v_valor
    from _ab where categoria = p_categoria;

  select coalesce(jsonb_agg(jsonb_build_object(
           'aluno', coalesce(nome,'(sem nome)'),
           'cpf', case when length(cpf) = 11
                       then substr(cpf,1,3) || '.***.' || substr(cpf,7,3) || '-**' else '***' end,
           'em_aberto', em_aberto,
           'contrato_2026_2', case when confirmado then 'Confirmado'
                                   when iniciou then 'Aberto — iniciou e não concluiu'
                                   when anulado then 'Anulado / Cancelado'
                                   else 'sem contrato 2026/2 no Prime' end,
           'situacao_academica_crm', coalesce(situacao_academica, '(sem informação)')
         ) order by em_aberto desc), '[]'::jsonb)
    into v_out
    from (select * from _ab where categoria = p_categoria
           order by em_aberto desc limit p_limite offset p_offset) z;

  return jsonb_build_object('categoria', p_categoria, 'total_cpfs', v_total, 'total_valor', v_valor,
                            'limite', p_limite, 'offset', p_offset, 'linhas', v_out);
end; $$;
revoke all on function public.carteira_2026_1_academico_detalhe(text,int,int) from public, anon;
grant execute on function public.carteira_2026_1_academico_detalhe(text,int,int) to authenticated;

-- As categorias precisam somar o universo: se não somarem, a migration falha.
do $$
declare v jsonb; soma int;
begin
  v := public.carteira_2026_1_academico();
  if coalesce((v->'total'->>'cpfs')::int,0) = 0 then raise exception 'universo vazio'; end if;
  select sum((x->>'cpfs')::int) into soma from jsonb_array_elements(v->'categorias') x;
  if soma <> (v->'total'->>'cpfs')::int then
    raise exception 'categorias nao somam: % x %', soma, v->'total'->>'cpfs';
  end if;
  perform public.carteira_2026_1_academico_detalhe('Exceção | Matrícula com pendência', 5, 0);
end $$;

commit;
