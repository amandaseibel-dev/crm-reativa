-- Entrada nao pode contar renegociacao. E o resultado vira uma FAIXA.
--
-- Correcao de 20260826060000, encontrada ao preparar a leitura executiva de
-- agosto. A versao anterior somava TODO acordo importado como "entrou" -- isto
-- e, como divida nova. Medido em prod 2026-08-25, dos acordos importados no
-- mes:
--
--   R$ 2.163.427,15 (249)  ->  JA APONTAM para o titulo que substituiram.
--                              E renegociacao de divida ja contada, nao entrada.
--   R$   885.138,02 (309)  ->  sem vinculo nenhum. Nao da para saber.
--
-- Contar os R$ 2,16 mi como entrada inflava o "entrou" de agosto em quase o
-- dobro e fazia o resultado do mes parecer -R$ 3,79 mi quando esta entre
-- -R$ 637 mil e -R$ 1,52 mi. Num numero que vai para a diretoria, isso e a
-- diferenca entre "a operacao nao deu conta" e "a operacao quase empatou com a
-- remessa".
--
-- POR QUE UMA FAIXA E NAO UM NUMERO: 83% dos acordos importados nao registram
-- quais titulos substituiram (ver o defeito estrutural da importacao). Para
-- esses, escolher "e divida nova" ou "e renegociacao" seria chutar e entregar
-- precisao falsa. O painel passa a devolver `resultado_min` e `resultado_max`,
-- e a tela mostra o intervalo. Quando a importacao passar a gravar o vinculo,
-- a faixa fecha sozinha.
--
-- `renegociou` entra como linha propria: nao soma em lugar nenhum, mas fica
-- visivel -- e volume grande demais para ficar escondido.
--
-- Rollback: supabase/rollbacks/20260826070000_movimento_entrada_nao_conta_renegociacao.sql
-- corpo aplicado em prod nesta migration:

create or replace function public.saude_carteira_movimento(p_alunos uuid[], p_de date, p_ate date)
returns jsonb language sql stable security definer set search_path to 'public' as $function$
  with
  liq_acordo as (
    select count(*) qtd, coalesce(sum(p.valor),0) valor
    from public.parcelas p
    join public.acordos ac on ac.id = p.acordo_id
    where p.status = 'PAGO' and p.pago_em is not null
      and (p.pago_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
      and ac.aluno_id = any(p_alunos)
  ),
  liq_mensal as (
    select count(*) qtd, coalesce(sum(coalesce(t.saldo_corrigido,t.valor_original,0)),0) valor
    from public.acordos_titulos t
    where t.situacao = 'PAGO'
      and (t.atualizado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
      and t.aluno_id = any(p_alunos)
  ),
  ent_titulo as (
    select count(*) qtd, coalesce(sum(coalesce(t.saldo_corrigido,t.valor_original,0)),0) valor
    from public.acordos_titulos t
    where (t.created_at at time zone 'America/Sao_Paulo')::date between p_de and p_ate
      and t.aluno_id = any(p_alunos)
  ),
  -- acordo importado SEM vinculo: nao da para saber se e divida nova ou
  -- renegociacao de titulo que ja estava na base. Fica em separado, nao somado.
  ent_acordo_indef as (
    select count(*) qtd, coalesce(sum(ac.valor_total),0) valor
    from public.acordos ac
    where (ac.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
      and ac.criado_por_email = 'importacao@sistema'
      and ac.aluno_id = any(p_alunos)
      and not exists (select 1 from public.acordo_titulo_vinculo v where v.acordo_id = ac.id)
  ),
  -- acordo importado COM vinculo: substitui divida ja contada. NAO e entrada.
  ent_acordo_reneg as (
    select count(*) qtd, coalesce(sum(ac.valor_total),0) valor
    from public.acordos ac
    where (ac.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
      and ac.criado_por_email = 'importacao@sistema'
      and ac.aluno_id = any(p_alunos)
      and exists (select 1 from public.acordo_titulo_vinculo v where v.acordo_id = ac.id)
  ),
  recl as (
    select count(*) qtd, coalesce(sum(coalesce(t.saldo_corrigido,t.valor_original,0)),0) valor
    from public.acordos_titulos t
    join public.acordo_titulo_vinculo v on v.titulo_id = t.id
    where t.situacao = 'NEGOCIADO' and coalesce(v.ativo, true)
      and (v.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
      and t.aluno_id = any(p_alunos)
  )
  select jsonb_build_object(
    'de', p_de, 'ate', p_ate,
    'liquidou', jsonb_build_object(
      'acordo_valor', (select valor from liq_acordo), 'acordo_qtd', (select qtd from liq_acordo),
      'mensalidade_valor', (select valor from liq_mensal), 'mensalidade_qtd', (select qtd from liq_mensal),
      'total', (select valor from liq_acordo) + (select valor from liq_mensal)
    ),
    'entrou', jsonb_build_object(
      'titulo_valor', (select valor from ent_titulo), 'titulo_qtd', (select qtd from ent_titulo),
      'acordo_indefinido_valor', (select valor from ent_acordo_indef),
      'acordo_indefinido_qtd', (select qtd from ent_acordo_indef),
      'minimo', (select valor from ent_titulo),
      'maximo', (select valor from ent_titulo) + (select valor from ent_acordo_indef)
    ),
    'renegociou', jsonb_build_object(
      'valor', (select valor from ent_acordo_reneg), 'qtd', (select qtd from ent_acordo_reneg)
    ),
    'reclassificou', jsonb_build_object(
      'valor', (select valor from recl), 'qtd', (select qtd from recl)
    ),
    'resultado_min',
      ((select valor from liq_acordo) + (select valor from liq_mensal))
      - ((select valor from ent_titulo) + (select valor from ent_acordo_indef)),
    'resultado_max',
      ((select valor from liq_acordo) + (select valor from liq_mensal))
      - (select valor from ent_titulo),
    'qualidade_da_data', jsonb_build_object(
      'acordo', 'data real de pagamento (parcelas.pago_em)',
      'mensalidade', 'aproximada: a tabela nao tem data de pagamento, usa a ultima alteracao do registro'
    ),
    'calculado_em', now()
  );
$function$;

comment on function public.saude_carteira_movimento(uuid[], date, date) is
  'Movimento da carteira no periodo. ENTRADA nao conta acordo importado que substitui titulo ja na base (renegociacao) -- esse vai em `renegociou`. Acordo importado sem vinculo fica como indefinido, e o resultado vira uma FAIXA (min/max) em vez de um numero falsamente preciso.';
