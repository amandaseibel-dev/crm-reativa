-- Efetividade 2026/2 por MES DE VENCIMENTO -- um cartao por mes.
--
-- Esta funcao NAO classifica nada. Ela so AGREGA, por mes de vencimento, o que
-- `carteira_2026_2_classificar()` ja decide titulo a titulo. Toda regra de
-- classificacao, de valor recebido e de saldo continua morando la; se a regra
-- mudar, muda em um lugar so e este cartao acompanha.
--
-- As seis linhas do cartao, nos termos aprovados pela gestao em 29/09/2026:
--
--   Entrou     valor original de TODOS os titulos do mes
--   Pago       campo `recuperado`. NAO e, em todo mes, pagamento identificado
--              titulo a titulo: onde o acordo cobre mais de um titulo o valor
--              vem de rateio. `pago_composicao` separa "atribuido diretamente"
--              de "por rateio", e a tela mostra os dois.
--   Negociado  saldo ainda nao pago de ACORDO ATIVO (regular/atraso/quebrado --
--              `acordos.status = 'ATIVO'`, conforme docs/REGRA-SALDO-COBRAVEL.md)
--   Cancelado  titulo com a COBRANCA cancelada (faixa CANCELADO). Acordo
--              cancelado NAO cancela o titulo: esse titulo nao tem acordo ativo,
--              entao o saldo dele cai em "Em aberto", que e onde ele e cobravel.
--   Em aberto  saldo sem acordo ativo
--   Pendente   EM_CONFERENCIA + ACADEMICO, à parte de proposito: e o que ainda
--   de classi- nao foi classificado. Nao entra diluido nas outras cinco.
--   ficacao
--
-- INVARIANTE: Entrou = Pago + Negociado + Em aberto + Cancelado + Pendente.
-- Ela fecha porque o classificador garante `valor_original = recuperado + saldo`
-- fora de CANCELADO, e porque um titulo pendente nunca tem valor recebido. O
-- bloco `conferencia` remede isso a cada chamada e a tela mostra o aviso se um
-- dia deixar de fechar -- conta e registra, nao corrige.
--
-- LIMITE DECLARADO NA TELA: nos titulos com acordo, `recuperado` e o valor
-- original do titulo vezes a proporcao de parcelas pagas do ACORDO. O acordo
-- pode cobrir titulos de meses diferentes, entao o rateio move valor recebido
-- entre cartoes. Por isso o cartao separa "atribuido diretamente" de "por
-- rateio" (`pago_composicao`): a medida sai do proprio banco a cada chamada,
-- e nenhum numero de producao fica escrito aqui.
--
-- O saldo aqui e o do classificador (valor original - recebido). NAO e o saldo
-- cobravel de docs/REGRA-SALDO-COBRAVEL.md, que segue sem implementacao (Fase
-- 5) -- por isso a funcao devolve `saldo_metodo`, que a tela exibe.

create or replace function public.carteira_2026_2_por_vencimento()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_out jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  with c as (select * from public.carteira_2026_2_classificar()),
  m as (
    select *,
      (faixa = 'CANCELADO')                     as eh_cancelado,
      (faixa in ('EM_CONFERENCIA','ACADEMICO')) as eh_pendente,
      (acordo_id is not null
        and acordo_estado in ('regular','atraso','quebrado')) as acordo_ativo
      from c
  ),
  -- Uma linha por (titulo, situacao em que ele entra). Aluno distinto e titulo
  -- distinto saem daqui por CONTAGEM, nunca por soma: o mesmo aluno pode ter
  -- titulos em situacoes diferentes e conta em cada uma delas.
  b as (
    select competencia, 'entrou'     as bucket, aluno_id, titulo_id, valor_original as valor from m
    union all
    select competencia, 'pago',      aluno_id, titulo_id, recuperado     from m
      where not eh_cancelado and not eh_pendente and recuperado > 0
    union all
    select competencia, 'negociado', aluno_id, titulo_id, saldo          from m
      where not eh_cancelado and not eh_pendente and acordo_ativo and saldo > 0
    union all
    select competencia, 'em_aberto', aluno_id, titulo_id, saldo          from m
      where not eh_cancelado and not eh_pendente and not acordo_ativo and saldo > 0
    union all
    select competencia, 'cancelado', aluno_id, titulo_id, valor_original from m
      where eh_cancelado
    union all
    select competencia, 'pendente',  aluno_id, titulo_id, valor_original from m
      where eh_pendente
  ),
  -- Quantos titulos cada acordo cobre (em qualquer safra). Com um titulo so,
  -- o rateio nao distribui nada -- o recebido daquele acordo e daquele titulo
  -- por identidade. Com mais de um, o valor do mes depende de rateio. Isto NAO
  -- muda nenhum valor: so mede quanto do "Pago" e atribuicao e quanto e rateio.
  cobertura as (
    select t.acordo_id, count(*) titulos_do_acordo
      from public.acordos_titulos t
     where coalesce(t.tipo_boleto,'') <> 'Acordo' and t.situacao <> 'DUPLICADA'
       and t.acordo_id is not null
     group by 1
  ),
  -- Composicao do Pago POR MES. Um total principal de Pago, e dentro dele a
  -- divisao entre o que esta atribuido ao proprio titulo e o que vem de rateio.
  -- Por construcao: atribuido + rateado = Pago do mes, sempre.
  pago_origem as (
    select m.competencia,
           round(coalesce(sum(m.recuperado) filter (
             where m.acordo_id is null or coalesce(cb.titulos_do_acordo,0) = 1), 0), 2) atribuido,
           round(coalesce(sum(m.recuperado) filter (
             where m.acordo_id is not null and coalesce(cb.titulos_do_acordo,0) > 1), 0), 2) rateado
      from m left join cobertura cb on cb.acordo_id = m.acordo_id
     where m.recuperado > 0 and not m.eh_cancelado and not m.eh_pendente
     group by 1
  ),
  agg as (
    select competencia, bucket,
           count(distinct aluno_id) alunos, count(distinct titulo_id) titulos,
           round(sum(valor),2) valor
      from b group by 1,2
  ),
  mes as (
    select competencia,
           min(vencimento) vencimento_de, max(vencimento) vencimento_ate,
           count(distinct vencimento) datas
      from m group by 1
  ),
  -- O detalhe por STATUS abaixo dos numeros do cartao e a `sub_faixa` do
  -- classificador -- o rotulo que ja existe por titulo, nao um rotulo novo.
  st as (
    select competencia, sub_faixa,
           count(distinct aluno_id) alunos, count(distinct titulo_id) titulos,
           round(sum(valor_original),2) valor
      from m group by 1,2
  ),
  cartao as (
    select x.competencia,
           jsonb_build_object(
             'competencia', x.competencia,
             'vencimento_de', x.vencimento_de, 'vencimento_ate', x.vencimento_ate,
             'datas_de_vencimento', x.datas,
             'situacoes', (
               select jsonb_object_agg(a.bucket, jsonb_build_object(
                        'alunos', a.alunos, 'titulos', a.titulos, 'valor', a.valor))
                 from agg a where a.competencia = x.competencia
             ),
             'pago_composicao', (
               select jsonb_build_object('atribuido', po.atribuido, 'rateado', po.rateado)
                 from pago_origem po where po.competencia = x.competencia
             ),
             'status', (
               select coalesce(jsonb_agg(jsonb_build_object(
                        'status', s.sub_faixa, 'alunos', s.alunos,
                        'titulos', s.titulos, 'valor', s.valor)
                        order by s.valor desc), '[]'::jsonb)
                 from st s where s.competencia = x.competencia
             )
           ) cartao
      from mes x
  ),
  conferencia as (
    select count(*) filter (where nao_fecha) meses_que_nao_fecham,
           round(coalesce(sum(dif),0),2) diferenca_total
      from (
        select round(coalesce(max(valor) filter (where bucket = 'entrou'),0)
                     - coalesce(sum(valor) filter (where bucket <> 'entrou'),0), 2) dif,
               abs(round(coalesce(max(valor) filter (where bucket = 'entrou'),0)
                     - coalesce(sum(valor) filter (where bucket <> 'entrou'),0), 2)) > 0.05 nao_fecha
          from agg group by competencia
      ) z
  )
  select jsonb_build_object(
    'gerado_em', now(),
    'semestre', '2026/2',
    'saldo_metodo',
      'Saldo do classificador 2026/2: saldo = valor original - recebido. Nos titulos ligados a um '
      'acordo que cobre mais de um titulo, o recebido do mes vem de rateio pela proporcao de '
      'parcelas pagas do acordo, nao de pagamento identificado titulo a titulo -- o campo '
      'pago_composicao mede quanto e cada coisa, mes a mes. Nao usa o saldo cobravel da norma (sem implementacao).',
    'atualizado_em', jsonb_build_object(
      'prime_coletado_em', (select max(coletado_em) from public.prime_titulo_semestre),
      'titulo_mexido_em',  (select max(t.atualizado_em) from public.acordos_titulos t
                              where t.id in (select titulo_id from m))
    ),
    'conferencia', (select to_jsonb(z) from conferencia z),
    'pago_composicao', (select jsonb_build_object(
                           'atribuido', round(coalesce(sum(atribuido),0),2),
                           'rateado',   round(coalesce(sum(rateado),0),2))
                          from pago_origem),
    'total', jsonb_build_object(
      'vencimento_de',  (select min(vencimento_de)  from mes),
      'vencimento_ate', (select max(vencimento_ate) from mes),
      -- Duas unidades de contagem, ambas declaradas. A tela diz qual e qual em
      -- vez de harmonizar por conta propria: mexer em ficha duplicada e outro
      -- assunto, e nao se conserta cadastro para fechar indicador.
      'fichas', (select count(distinct aluno_id) from m),
      'cpfs',   (select count(distinct cpf) from m),
      'situacoes', (
        select jsonb_object_agg(bucket, jsonb_build_object(
                 'alunos', alunos, 'titulos', titulos, 'valor', valor))
          from (select bucket, count(distinct aluno_id) alunos,
                       count(distinct titulo_id) titulos, round(sum(valor),2) valor
                  from b group by 1) t
      )
    ),
    'meses', (select coalesce(jsonb_agg(cartao order by competencia), '[]'::jsonb) from cartao)
  ) into v_out;

  return v_out;
end;
$function$;

-- Mesmo portao das irmas: leitura de gestao/diretoria, nunca anonimo. Restringir
-- e portao interno (`carteira_2026_1_pode_ler`), nao revoke de authenticated.
revoke all on function public.carteira_2026_2_por_vencimento() from public, anon;
grant execute on function public.carteira_2026_2_por_vencimento() to authenticated, service_role;
