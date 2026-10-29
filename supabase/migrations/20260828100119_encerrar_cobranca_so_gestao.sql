-- Encerrar cobranca deixa de ser tabulacao de operador.
--
-- Amanda, 28/08/2026: "tire a opcao de cancelamento de cobranca, juridico, tudo
-- que encerre da operacao, e deixe apenas para mim e para fernanda e adm".
--
-- O CASO QUE ORIGINOU. Leonardo Soares de Sena: o aluno alegou cancelamento
-- definitivo, o operador acreditou e tabulou "Cancelado" em 17/08. Isso gravou
-- CANCELAMENTO_COBRANCA no cadastro e tirou o aluno da cobranca E da acao
-- massiva -- com R$ 1.923,09 em aberto. A Amanda conferiu com o ADM: o
-- cancelamento nao existia.
--
-- O problema nao e o operador ter errado. E o sistema permitir que uma frase do
-- aluno, sem nenhuma validacao, apague um caso da operacao inteira.
--
-- AS TRES QUE ENCERRAM (as unicas com bloqueia_acionamento = true):
--     CANCELAMENTO_COBRANCA   Cancelamento definitivo de cobranca
--     SUSPENSAO_COBRANCA      Suspensao de cobranca
--     JURIDICO                Juridico
--
-- (ELOGIO_ATENDIMENTO tambem esta no grupo ENCERRAMENTO, mas nao bloqueia nada
-- -- continua liberado para todos.)
--
-- COMO FICA ESCONDIDO, sem depender da tela: a lista de tabulacoes e lida
-- direto da tabela pelo front. Entao a propria politica de leitura filtra --
-- quem nao e gestao nao RECEBE essas tres, e elas somem do seletor sozinhas.
-- Nao ha versao antiga da tela que consiga mostra-las.
--
-- E A TRAVA DE VERDADE, no banco: mesmo chamando a API direto, aplicar um
-- desses status exige gestao. Esconder e conveniencia; a trava e a seguranca.
--
-- A trava so barra o encerramento NOVO -- reescrever um status que ja estava la
-- nao e o operador encerrando nada, e travar isso quebraria rotina legitima.
--
-- Gestao aqui e quem usuario_e_gestao() ja reconhece: Amanda, Fernanda e Amanda
-- ADM -- exatamente as tres que ela nomeou.
--
-- FICA PENDENTE para ela decidir: 8 alunos seguem marcados com cancelamento e
-- ainda devem R$ 130.959,68. Um era o Leonardo (revertido). Os outros 7 tem
-- origem diferente e podem ser cancelamentos legitimos do ADM -- precisam de
-- conferencia caso a caso, nao de correcao automatica.

alter table public.tabulacoes
  add column if not exists somente_gestao boolean not null default false;

update public.tabulacoes
   set somente_gestao = true
 where codigo in ('CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA','JURIDICO');

comment on column public.tabulacoes.somente_gestao is
  'Tabulacao que ENCERRA o caso na operacao. So gestao ve e aplica -- a politica de leitura esconde do operador e o gatilho em alunos barra a gravacao.';

drop policy if exists tabulacoes_leitura_autenticado on public.tabulacoes;
create policy tabulacoes_leitura_autenticado on public.tabulacoes
  for select
  using (
    not somente_gestao
    or coalesce(public.usuario_e_gestao(), false)
    or coalesce(auth.role(),'') = 'service_role'
  );

create or replace function public._encerramento_so_gestao()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_encerra text[] := array['CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA','JURIDICO'];
  v_novo text[];
  v_antigo text[];
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role'
                       or auth.jwt() is null
                       or session_user in ('postgres','reativa_responsavel_executor');
begin
  if v_sistema or coalesce(public.usuario_e_gestao(), false) then
    return new;
  end if;

  v_novo := array[upper(coalesce(new.status_atual,'')), upper(coalesce(new.status_jornada,'')),
                  upper(coalesce(new.status_acionamento,''))];
  v_antigo := array[upper(coalesce(old.status_atual,'')), upper(coalesce(old.status_jornada,'')),
                    upper(coalesce(old.status_acionamento,''))];

  if (v_novo && v_encerra) and not (v_antigo && v_encerra) then
    raise exception
      'Encerrar cobrança (cancelamento, suspensão ou jurídico) é decisão da gestão. Registre a solicitação para Amanda, Fernanda ou Amanda ADM.'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_encerramento_so_gestao on public.alunos;
create trigger trg_encerramento_so_gestao
before update of status_atual, status_jornada, status_acionamento
on public.alunos
for each row execute function public._encerramento_so_gestao();
