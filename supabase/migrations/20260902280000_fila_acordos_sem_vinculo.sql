-- Fila dos acordos que ainda não dizem qual mensalidade substituíram.
--
-- O PROBLEMA. Em 02/09/2026 havia 1.490 acordos ativos sem NENHUM título
-- vinculado, R$ 5,96 milhões. O vínculo é feito à mão, na ficha do aluno
-- (FinanceiroAluno), e não existia lista que levasse até eles -- a gestão
-- garimpava um por um.
--
-- POR QUE NÃO DÁ PARA AUTOMATIZAR POR VALOR, e isso foi medido: dos 1.490,
-- ZERO tem a soma dos títulos abertos batendo com o valor do acordo. Acordo
-- carrega juros, desconto e honorário, então nunca fecha com o nominal das
-- mensalidades. Regra automática por valor seria chute, e chute aqui já quase
-- apagou R$ 337 mil legítimos antes. A decisão continua sendo de quem olha --
-- esta função só ORDENA.
--
-- A PRIORIDADE É O DINHEIRO QUE JÁ ENTROU. 154 desses acordos já têm parcela
-- PAGA, R$ 283.104,80 recebidos. Sem o vínculo o sistema não sabe qual
-- mensalidade aquele pagamento liquidou -- e em 61 casos o aluno SEGUE com
-- título aberto sendo cobrado, 110 estão na fila com saldo vencido. Cobrar quem
-- já pagou é o pior erro possível, então esses vêm primeiro.
--
-- AS FAIXAS, medidas na criação:
--   1 PAGO_E_COBRADO   61 acordos, R$ 108.450,20  (R$ 43.904,07 já pagos)
--   2 PAGO             93 acordos, R$ 529.851,17  (R$ 239.200,73 já pagos)
--   3 FACIL           227 acordos, R$ 721.361,61  (1 a 2 candidatos)
--   4 MEDIO           565 acordos, R$ 2.421.693,56
--   5 DIFICIL          39 acordos, R$ 396.439,56  (6+ candidatos)
--   9 SEM_CANDIDATO   505 acordos, R$ 1.778.870,77
--
-- SEM_CANDIDATO merece explicação: não há o outro lado do vínculo -- alunos sem
-- título nenhum na base, títulos já em OUTRO acordo, ou só título quitado.
-- Garimpar esses é trabalho impossível, não trabalho pendente. Ficam na fila
-- para não sumirem, mas em faixa própria, escondida por padrão na tela.
--
-- Candidato = título do MESMO aluno, situação ABERTO, não quitado, que não seja
-- o boleto do próprio acordo (`tipo_boleto <> 'Acordo'`, senão conta a dívida
-- duas vezes) e que ainda não esteja vinculado a acordo nenhum.
--
-- O PORTÃO é o mesmo das funções de Saúde: cron/serviço (sem JWT) passa,
-- usuário logado só passa se for gestão.
create or replace function public.acordos_sem_vinculo_fila()
returns table (
  acordo_id uuid, numero_acordo text, aluno_id uuid, nome text, cpf text,
  valor_total numeric, saldo numeric, status text, criado_em timestamptz,
  operador_email text, qtd_candidatos integer, soma_candidatos numeric,
  venc_mais_antigo date, venc_mais_novo date,
  parcelas_pagas integer, valor_ja_pago numeric,
  ordem integer, faixa text
)
language sql stable security definer set search_path to 'public'
as $$
  with sem as (
    select a.id, a.numero_acordo, a.aluno_id, coalesce(a.valor_total,0) valor_total,
           coalesce(a.saldo,0) saldo, a.status, a.criado_em
    from public.acordos a
    where upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO')
      and not exists (select 1 from public.acordo_titulo_vinculo v
                       where v.acordo_id = a.id and coalesce(v.ativo,true))
  ), cand as (
    select s.*, count(t.id)::int qtd,
           coalesce(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),0) soma,
           min(t.vencimento) v_min, max(t.vencimento) v_max
    from sem s
    left join public.acordos_titulos t
      on t.aluno_id = s.aluno_id
     and upper(coalesce(t.situacao,'')) = 'ABERTO'
     and coalesce(lower(t.status),'') not in ('quitada')
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and not exists (select 1 from public.acordo_titulo_vinculo v
                      where v.titulo_id = t.id and coalesce(v.ativo,true))
    group by s.id, s.numero_acordo, s.aluno_id, s.valor_total, s.saldo, s.status, s.criado_em
  ), pago as (
    select c.*,
           (select count(*)::int from public.parcelas p where p.acordo_id = c.id
             and upper(coalesce(p.status,'')) in ('PAGO','PAGA','QUITADA','QUITADO')) pgs,
           (select coalesce(sum(p.valor),0) from public.parcelas p where p.acordo_id = c.id
             and upper(coalesce(p.status,'')) in ('PAGO','PAGA','QUITADA','QUITADO')) vpago
    from cand c
  )
  select p.id, p.numero_acordo, p.aluno_id, al.nome, al.cpf,
         p.valor_total, p.saldo, p.status, p.criado_em,
         al.responsavel_atual_email, p.qtd, p.soma, p.v_min, p.v_max, p.pgs, p.vpago,
         case when p.pgs > 0 and p.qtd > 0 then 1 when p.pgs > 0 then 2
              when p.qtd = 0 then 9 when p.qtd <= 2 then 3 when p.qtd <= 5 then 4 else 5 end,
         case when p.pgs > 0 and p.qtd > 0 then 'PAGO_E_COBRADO' when p.pgs > 0 then 'PAGO'
              when p.qtd = 0 then 'SEM_CANDIDATO' when p.qtd <= 2 then 'FACIL'
              when p.qtd <= 5 then 'MEDIO' else 'DIFICIL' end
  from pago p join public.alunos al on al.id = p.aluno_id
  where (auth.jwt() is null or public.usuario_e_gestao())
  order by 17, p.valor_total desc;
$$;

revoke all on function public.acordos_sem_vinculo_fila() from public, anon;
grant execute on function public.acordos_sem_vinculo_fila() to authenticated;
