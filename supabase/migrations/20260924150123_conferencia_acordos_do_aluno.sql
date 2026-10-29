-- Quem decide a qual acordo a mensalidade vai e a gestao, nao a sugestao.
--
-- O QUE FALTAVA. O bloco de decisao (20260923200455) mostra UM acordo: o que a
-- deteccao sugeriu, ou o candidato que a evidencia registrou. A tela manda esse
-- id para `prime_conferencia_vincular` e pronto -- nao ha por onde escolher
-- outro. Quando a sugestao esta errada, sobra rejeitar o titulo (volta para
-- ABERTO) e vincular pela ficha: duas etapas para uma decisao so.
--
-- E a sugestao erra. Medido em 24/09/2026 no boleto 4445066 (R$ 3.987,54): o
-- acordo sugerido era o 4691, de R$ 981,08 -- um quarto do titulo. O que fecha
-- em valor e o 4692 (R$ 4.590,26), criado e pago no mesmo dia. Nenhuma das
-- rotas de vinculo compara valor: foi assim que o vinculo automatico prendeu
-- R$ 64.362,00 num acordo de R$ 15.428,65 antes de ser pausado hoje.
--
-- Amanda, 24/09/2026: "eu quero decidir onde vincular, como era antes".
--
-- O QUE ESTA FUNCAO FAZ. Devolve TODOS os acordos do aluno com o efeito de
-- vincular a cada um -- lido das mesmas funcoes que vao executar
-- (`prime_liquidacao_acordo_pago_de_verdade`, a trava de
-- `prime_conferencia_vincular`), nunca reescrito em JavaScript. Assim a lista
-- nao promete o que o backend recusa, e o VALOR de cada acordo aparece ao lado
-- do numero: e a conferencia que faltava em todas as outras rotas.
--
-- NAO decide nada e nao escreve nada: e leitura. Quem grava continua sendo
-- `prime_conferencia_vincular`, com as mesmas travas e o mesmo motivo
-- obrigatorio.

create or replace function public.conferencia_acordos_do_aluno(p_aluno_id uuid)
returns table(
  acordo_id uuid, numero text, status text,
  valor_total numeric, qtd_parcelas integer, parcelas_abertas integer,
  criado_em date, efeito text, efeito_texto text, aceita_vinculo boolean
)
language plpgsql
stable security definer
set search_path to 'public'
set statement_timeout to '30s'
as $function$
begin
  if not (public.crm_usuario_pode_quitar_baixar() or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;
  if p_aluno_id is null then return; end if;

  return query
  with base as (
    select a.id, coalesce(a.numero_acordo::text, '(sem numero)') as numero,
           upper(coalesce(a.status, '')) as status,
           round(coalesce(a.valor_total, 0), 2) as valor_total,
           coalesce(a.qtd_parcelas, 0) as qtd_parcelas,
           a.criado_em::date as criado_em,
           (select count(*)::int from public.parcelas p
             where p.acordo_id = a.id
               and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA')) as parcelas_abertas
      from public.acordos a
     where a.aluno_id = p_aluno_id
  ),
  com_dinheiro as (
    select b.*,
           case when b.status = 'QUITADO'
                then coalesce((public.prime_liquidacao_acordo_pago_de_verdade(b.id)->>'suficiente')::boolean, false)
                else false end as dinheiro_cobre
      from base b
  )
  select c.id, c.numero, c.status, c.valor_total, c.qtd_parcelas, c.parcelas_abertas, c.criado_em,
         case
           when c.status in ('CANCELADO','CANCELADA')        then 'ACORDO_CANCELADO'
           when c.status = 'QUITADO' and c.dinheiro_cobre    then 'VIRA_PAGO'
           when c.status = 'QUITADO'                         then 'ACORDO_SEM_DINHEIRO_REAL'
           when c.status = 'ATIVO'                           then 'VIRA_NEGOCIADO'
           else 'ACORDO_NAO_ELEGIVEL'
         end,
         case
           when c.status in ('CANCELADO','CANCELADA') then
             'Acordo cancelado — o vínculo é recusado'
           when c.status = 'QUITADO' and c.dinheiro_cobre then
             'A mensalidade fica PAGA: acordo quitado e os pagamentos baixados cobrem o total'
           when c.status = 'QUITADO' then
             'Acordo quitado, mas os pagamentos baixados não cobrem o total — a trava recusa'
           when c.status = 'ATIVO' then
             'A mensalidade fica NEGOCIADA: a dívida passa a viver nas parcelas deste acordo'
           else 'Acordo em estado que não recebe vínculo'
         end,
         (c.status = 'ATIVO' or (c.status = 'QUITADO' and c.dinheiro_cobre))
    from com_dinheiro c
   -- O que aceita vinculo primeiro; depois o mais recente.
   order by (c.status = 'ATIVO' or (c.status = 'QUITADO' and c.dinheiro_cobre)) desc,
            c.criado_em desc, c.numero;
end;
$function$;

comment on function public.conferencia_acordos_do_aluno(uuid) is
  'Todos os acordos do aluno com o efeito de vincular a cada um, para a gestao ESCOLHER o acordo em vez de aceitar a sugestao. So leitura; quem grava e prime_conferencia_vincular.';

revoke all on function public.conferencia_acordos_do_aluno(uuid) from public;
grant execute on function public.conferencia_acordos_do_aluno(uuid) to authenticated, service_role;
