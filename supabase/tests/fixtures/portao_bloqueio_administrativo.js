// `public.aluno_bloqueio_administrativo` -- corpo EXATO de produção, lido por
// `pg_get_functiondef` em 08/10/2026.
//
// POR QUE ESTE ARQUIVO EXISTE. A fixture `confirmacao_d2` monta um subconjunto
// do schema (ela nasceu do fluxo de confirmação) e não traz esta função. Ela é
// o PORTÃO CANÔNICO de bloqueio administrativo -- quem sabe dizer que a cobrança
// de um aluno está suspensa, cancelada ou no jurídico -- e a regra de 07–08/10
// depende dela em dois lugares: no backfill, para achar o universo, e em
// `saldo_cobravel_aluno`, para excluir o suspenso do saldo cobrável.
//
// Fica num módulo próprio, e NÃO dentro da fixture compartilhada, porque mexer
// em `funcs.sql` mudaria o schema dos outros ~140 arquivos de teste. Importar
// aqui é aditivo: só quem precisa carrega.
//
// Depende de `normalizar_status_acionamento`, que a fixture JÁ tem.
export const PORTAO_BLOQUEIO_ADMINISTRATIVO = `
CREATE OR REPLACE FUNCTION public.aluno_bloqueio_administrativo(p_aluno_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_susp boolean; v_canc boolean; v_jur boolean; v_nao boolean;
  n1 text; n2 text; n3 text;
  susp_set text[] := array['SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  canc_set text[] := array['CANCELADO','CANCELAMENTO COBRANCA'];
begin
  select public.normalizar_status_acionamento(al.status_atual),
         public.normalizar_status_acionamento(al.status_acionamento),
         public.normalizar_status_acionamento(al.status_jornada)
    into n1, n2, n3
    from public.alunos al where al.id = p_aluno_id;
  if not found then return 'ALUNO_INEXISTENTE'; end if;

  select bool_or(public.normalizar_status_acionamento(c.status_atual)      = any(susp_set)
              or public.normalizar_status_acionamento(c.status_financeiro) = any(susp_set)
              or public.normalizar_status_acionamento(c.status_jornada)    = any(susp_set)),
         bool_or(public.normalizar_status_acionamento(c.status_atual)      = any(canc_set)
              or public.normalizar_status_acionamento(c.status_financeiro) = 'CANCELAMENTO COBRANCA'
              or public.normalizar_status_acionamento(c.status_jornada)    = any(canc_set)),
         bool_or(public.normalizar_status_acionamento(c.status_atual)      = 'JURIDICO'
              or public.normalizar_status_acionamento(c.status_financeiro) = 'JURIDICO'
              or public.normalizar_status_acionamento(c.status_jornada)    = 'JURIDICO'),
         bool_or(coalesce(c.nao_acionar,false))
    into v_susp, v_canc, v_jur, v_nao
    from public.casos c where c.aluno_id = p_aluno_id;

  -- status_acionamento='CANCELADO' e ACORDO cancelado, NAO cobranca cancelada:
  -- por isso n2 so casa com 'CANCELAMENTO COBRANCA'.
  if n1 = any(susp_set) or n2 = any(susp_set) or n3 = any(susp_set) or coalesce(v_susp,false)
     then return 'SUSPENSAO_COBRANCA'; end if;
  if n1 = any(canc_set) or n2 = 'CANCELAMENTO COBRANCA' or n3 = any(canc_set) or coalesce(v_canc,false)
     then return 'CANCELAMENTO_COBRANCA'; end if;
  if n1 = 'JURIDICO' or n2 = 'JURIDICO' or n3 = 'JURIDICO' or coalesce(v_jur,false)
     then return 'JURIDICO'; end if;
  if coalesce(v_nao,false) then return 'NAO_ACIONAR_EXPLICITO'; end if;
  return null;
end;
$function$;`;
