-- Devolver a carteira quem deve -- status falso os prendia fora.
--
-- Amanda, 28/08/2026: "o que for cancelamento de cobranca ou juridico deve sair
-- da base" -- e, sobre o resto: "segue".
--
-- O ACHADO. 335 casos estavam FORA da carteira ainda devendo R$ 2.824.517,68.
-- Separando pela regra dela:
--
--     cancelamento de cobranca  150 casos  R$ 1.346.223,69  -> sai, e decisao
--     juridico                   20 casos  R$   962.488,60  -> sai, e decisao
--     SEM MOTIVO                165 casos  R$   515.805,39  -> nao deveria sair
--
-- Os 170 primeiros estao certos: saem por decisao dela, mesmo devendo. A regra
-- ja estava sendo cumprida.
--
-- OS 165 ERAM STATUS FALSO. O que os prendia fora:
--     150  status_acionamento = 'SEM_SALDO_EM_ABERTO'  R$ 469.088,49
--      11  status_atual       = 'QUITADO'              R$  29.675,91
--       4  status_acionamento = 'QUITADO'              R$  17.040,99
--
-- Ou seja: o texto dizia que nao deviam nada e a conta dizia que deviam.
-- `caso_encerrado_operacional` trata 'SEM_SALDO_EM_ABERTO' como encerrado SEM
-- conferir saldo -- basta o texto estar la. E o mesmo defeito de familia dos
-- 148 marcados "quitado" sem quitado_em, de 27/08.
--
-- CONFERIDO UM A UM antes de mexer, pela funcao canonica
-- (aluno_saldo_pendente_detalhe): 165 de 165 devem mesmo, e o valor bate
-- exatamente com o da tela -- R$ 515.805,39. Zero falso positivo. Essa
-- conferencia nao e formalidade: foi ela que, em 27/08, impediu que eu
-- removesse R$ 1,6 milhao de divida real por confiar no saldo da tela.
--
-- Nenhum dos 165 e dos 288 que eu tirei ontem por saldo zero -- conferido.
--
-- O QUE FOI FEITO: onde o status era falso, virou 'EM_ABERTO' / 'Em cobranca'.
-- Nao apaga tabulacao verdadeira: so troca os dois valores que mentiam.
--
-- EFEITO: carteira de 13.935 para 14.095 casos; saldo de R$ 47.648.175,51 para
-- R$ 48.154.028,86. Sobram 175 fora com saldo, R$ 2.318.664,33 -- e sao os
-- cancelamentos e juridicos, que saem por decisao.
--
-- Reversivel por _backup_status_falso_20260828 (caso, aluno, os dois status de
-- antes e o saldo real apurado).

create table if not exists public._backup_status_falso_20260828 (
  caso_id uuid primary key,
  aluno_id uuid,
  status_atual_antes text,
  status_acionamento_antes text,
  saldo_real numeric,
  corrigido_em timestamptz default now()
);

with fora as (
  select v.caso_id, v.aluno_id, c.status_atual, c.status_acionamento
  from public.vw_saude_carteira v join public.casos c on c.id = v.caso_id
  where v.encerrado and coalesce(v.saldo_total,0) > 0.005
    -- Cancelamento e juridico SAEM por decisao dela: nao entram aqui.
    and not ('CANCELADO' in (upper(coalesce(c.status_acionamento,'')), upper(coalesce(c.status_atual,'')))
             or upper(coalesce(c.status_atual,'')) like '%CANCELAD%')
    and not (upper(coalesce(c.status_atual,'')) like '%JURID%'
             or upper(coalesce(c.status_acionamento,'')) like '%JURID%')
),
conf as (
  -- Fonte canonica, nunca o saldo da propria tela.
  select f.*, coalesce((public.aluno_saldo_pendente_detalhe(f.aluno_id)->>'total')::numeric,0) as saldo_real
  from fora f
)
insert into public._backup_status_falso_20260828 (caso_id, aluno_id, status_atual_antes, status_acionamento_antes, saldo_real)
select caso_id, aluno_id, status_atual, status_acionamento, saldo_real
from conf where saldo_real > 0.005
on conflict (caso_id) do nothing;

update public.casos c
   set status_acionamento = case
         when upper(coalesce(c.status_acionamento,'')) in ('SEM_SALDO_EM_ABERTO','QUITADO')
           then 'EM_ABERTO' else c.status_acionamento end,
       status_atual = case
         when upper(coalesce(c.status_atual,'')) in ('SEM_SALDO_EM_ABERTO','QUITADO')
           then 'Em cobrança' else c.status_atual end
  from public._backup_status_falso_20260828 b
 where c.id = b.caso_id;
