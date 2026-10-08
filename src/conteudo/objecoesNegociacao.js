// =============================================================================
// QUEBRAS DE OBJEÇÃO — conteúdo único, compartilhado
// -----------------------------------------------------------------------------
// Este texto é usado em DOIS lugares: a seção "Quebras de Objeção" do Portal
// Operacional (onde o operador consulta durante o atendimento) e o slide
// "Quebras de Objeção" da TV (onde ele passa no rodízio do telão).
//
// Mora aqui, e não no banco, por decisão de 08/10/2026: é texto institucional,
// que muda por revisão da gestão e não por operação do dia. Ficar no código
// mantém a regra de ouro da TV intacta — o telão não consulta nada — e o
// payload do snapshot não cresce um byte com isto.
//
// Para mudar um texto: edite aqui. Portal e TV mudam juntos, por construção.
//
// Campos: `pergunta` (o que o aluno diz) e `principal` (a resposta) existem em
// todos os 35 itens, junto de `objetivo` e `atencao`. `alternativa` existe em
// 34 e `firme` em 3 — quem renderiza precisa tratar a ausência.
// =============================================================================

export const OBJECOES = [
    {
      pergunta: "Vou pensar",
      principal: "Claro, sem problema. Só reforço que as condições atuais podem sofrer alteração posteriormente.",
      alternativa: "O que te faria se sentir mais seguro para conseguirmos concluir hoje?",
      objetivo: "Descobrir a objeção real.",
      atencao: "Não encurralar o aluno."
    },
    {
      pergunta: "Não tenho dinheiro",
      principal: "Entendo perfeitamente. Podemos verificar uma condição dentro das possibilidades disponíveis para facilitar sua regularização.",
      alternativa: "Posso verificar uma condição mais leve para tentarmos avançar sem comprometer seu orçamento.",
      objetivo: "Manter a negociação aberta com empatia.",
      atencao: "Evitar tom agressivo ou pressão excessiva."
    },
    {
      pergunta: "Não tenho cartão",
      principal: "Entendo. Para acordos, o parcelamento em boleto não é permitido. As condições são pagamento à vista ou cartão de crédito, conforme a política vigente.",
      alternativa: "Se você não conseguir quitar o saldo total agora, podemos verificar o pagamento das parcelas individualmente, uma a uma.",
      firme: "Enquanto houver parcelas vencidas do acordo, a matrícula não será liberada.",
      objetivo: "Apresentar a alternativa permitida sem criar uma condição fora da política.",
      atencao: "Não oferecer reparcelamento do acordo em boleto e não insistir no uso de cartão de terceiros."
    },
    {
      pergunta: "Me chama depois",
      principal: "Claro. Qual seria o melhor horário para eu retornar e conseguirmos verificar isso juntos com mais calma?",
      alternativa: "Posso deixar o retorno combinado para não perdermos o acompanhamento da negociação.",
      firme: "Quanto antes avaliarmos as condições disponíveis, mais rápido conseguimos definir uma solução.",
      objetivo: "Gerar compromisso de retorno.",
      atencao: "Evitar parecer insistente ou pressionar excessivamente."
    },
    {
      pergunta: "Já paguei",
      principal: "Perfeito, obrigado por informar. Pode me encaminhar o comprovante para validarmos e regularizarmos o quanto antes?",
      alternativa: "Assim conseguimos verificar internamente e evitar qualquer divergência.",
      objetivo: "Solicitar comprovante sem gerar confronto.",
      atencao: "Nunca afirmar erro do aluno ou do sistema antes da validação."
    },
    {
      pergunta: "Não reconheço esse valor",
      principal: "Posso te explicar a composição do débito para entendermos juntos de onde vêm os valores.",
      alternativa: "Consigo detalhar os valores e encargos registrados para você conferir.",
      objetivo: "Reduzir resistência e abrir espaço para negociação.",
      atencao: "Evitar tom defensivo ou discussão."
    },
    {
      pergunta: "Achei que estava trancado",
      principal: "Entendo. Posso verificar no sistema como ficou a situação acadêmica e te orientar da melhor forma.",
      alternativa: "Vamos conferir o registro antes de qualquer conclusão.",
      objetivo: "Evitar confronto e manter o aluno na conversa.",
      atencao: "Não confirmar cancelamento ou trancamento sem validação."
    },
    {
      pergunta: "Não estou estudando mais",
      principal: "Entendo. Mesmo sem vínculo ativo, valores anteriores podem permanecer em aberto. Vamos verificar sua situação.",
      alternativa: "Posso conferir os valores registrados e as condições disponíveis para regularização.",
      objetivo: "Separar vínculo acadêmico da pendência financeira.",
      atencao: "Evitar tom agressivo."
    },
    {
      pergunta: "Não sabia que tinha débito",
      principal: "Sem problema. Estou entrando em contato justamente para te atualizar sobre a situação e verificarmos juntos a melhor solução.",
      alternativa: "Posso te explicar os valores e também verificar as condições disponíveis.",
      objetivo: "Abrir diálogo sem gerar resistência.",
      atencao: "Evitar tom acusatório."
    },
    {
      pergunta: "Vou esperar a rematrícula",
      principal: "Entendo seu ponto. Ainda assim, podemos avaliar a regularização agora conforme as condições disponíveis.",
      alternativa: "Posso verificar as possibilidades atuais para você avaliar com calma.",
      objetivo: "Incentivar a análise da regularização sem prometer efeito acadêmico.",
      atencao: "Não vincular ou prometer rematrícula."
    },
    {
      pergunta: "Só vou pagar quando voltar a estudar",
      principal: "Entendo. Mesmo assim, podemos verificar a situação financeira atual e as possibilidades de regularização.",
      alternativa: "Posso te apresentar as condições disponíveis neste momento.",
      objetivo: "Antecipar a análise da pendência.",
      atencao: "Não prometer benefício acadêmico."
    },
    {
      pergunta: "Vou pagar no final do semestre",
      principal: "Entendo. Posso saber por qual motivo você prefere deixar o pagamento para o final do semestre?",
      alternativa: "Dependendo da sua situação, podemos verificar se existe alguma alternativa para ajudar você a regularizar ou encaminhar isso hoje.",
      objetivo: "Entender o motivo real do adiamento e manter o diálogo aberto.",
      atencao: "Não encerrar a conversa apenas aceitando o adiamento. Fazer perguntas abertas, sem pressionar."
    },
    {
      pergunta: "Não tenho interesse em negociar",
      principal: "Entendo. Posso saber qual é o principal motivo que hoje impede o pagamento ou uma negociação?",
      alternativa: "Existe algum ponto específico, como valor, forma de pagamento ou momento financeiro, que esteja dificultando? Podemos verificar se há algo que ajude a resolver sua situação hoje.",
      objetivo: "Identificar a objeção real e verificar se existe uma alternativa aplicável.",
      atencao: "Manter tom respeitoso e aberto. Se o aluno não quiser continuar a conversa, não pressionar."
    },
    {
      pergunta: "Estou desempregado(a)",
      principal: "Entendo perfeitamente sua situação. Podemos verificar uma condição mais adequada dentro das possibilidades disponíveis.",
      alternativa: "O objetivo é buscarmos algo que fique viável para o seu momento atual.",
      objetivo: "Demonstrar empatia sem perder a negociação.",
      atencao: "Manter abordagem humanizada."
    },
    {
      pergunta: "Estou passando por problemas pessoais",
      principal: "Sinto muito pela situação. Podemos verificar juntos uma alternativa possível para tentar facilitar este momento.",
      alternativa: "O objetivo é buscarmos uma solução viável dentro das condições disponíveis.",
      objetivo: "Criar acolhimento e manter abertura para negociação.",
      atencao: "Evitar insistência excessiva."
    },
    {
      pergunta: "Vou falar com meus pais/esposo(a)",
      principal: "Perfeito. Qual seria o melhor horário para retornarmos depois que vocês alinharem?",
      alternativa: "Posso deixar um retorno programado para retomarmos a conversa.",
      objetivo: "Gerar compromisso de retorno.",
      atencao: "Evitar pressionar terceiros ou compartilhar dados com eles."
    },
    {
      pergunta: "Não consigo dar entrada",
      principal: "Entendo. Posso verificar se existe alguma condição alternativa dentro da política vigente.",
      alternativa: "Vamos conferir o que é possível antes de concluir que não há alternativa.",
      objetivo: "Manter a negociação ativa.",
      atencao: "Não prometer exceções sem aprovação."
    },
    {
      pergunta: "Só consigo parcelado",
      principal: "Vamos verificar primeiro se a pendência é de mensalidade ou de acordo, porque as condições são diferentes.",
      alternativa: "Se for acordo, não podemos reparcelar em boleto. A regularização é à vista ou no cartão; sem condição de quitação total, podemos oferecer o pagamento das parcelas individualmente.",
      objetivo: "Aplicar a condição correta conforme o tipo da dívida.",
      atencao: "Em acordos, não oferecer novo parcelamento em boleto. Havendo parcelas vencidas, sinalizar que a matrícula não será liberada."
    },
    {
      pergunta: "Não tenho limite",
      principal: "Entendo. Podemos avaliar outras formas de negociação disponíveis que não dependam desse limite.",
      alternativa: "Vamos verificar quais opções estão disponíveis para o seu caso.",
      objetivo: "Evitar encerramento precoce da negociação.",
      atencao: "Não insistir excessivamente no cartão."
    },
    {
      pergunta: "Tenho outras dívidas",
      principal: "Entendo. Podemos verificar uma condição que ajude a organizar esta pendência dentro da sua realidade.",
      alternativa: "O objetivo é encontrarmos uma alternativa viável sem desconsiderar seu momento financeiro.",
      objetivo: "Mostrar possibilidade de regularização sem julgamento.",
      atencao: "Evitar julgamento financeiro."
    },
    {
      pergunta: "Achei injusta a cobrança",
      principal: "Entendo sua percepção. Posso te explicar melhor a situação e verificarmos juntos os detalhes.",
      alternativa: "Vamos conferir a composição e os registros antes de avançarmos.",
      objetivo: "Reduzir confronto.",
      atencao: "Nunca discutir com o aluno."
    },
    {
      pergunta: "Não usei o curso / Não consegui acessar",
      principal: "Entendo. Posso verificar as informações registradas e te orientar sobre a situação do débito.",
      alternativa: "Vamos conferir o histórico antes de qualquer conclusão.",
      objetivo: "Evitar conflito inicial.",
      atencao: "Não invalidar o relato do aluno."
    },
    {
      pergunta: "Vou entrar na justiça",
      principal: "Você tem o direito de buscar orientação. Da nossa parte, podemos continuar esclarecendo as possibilidades administrativas disponíveis.",
      alternativa: "Se desejar, posso explicar as condições vigentes e registrar sua manifestação.",
      objetivo: "Desarmar conflito.",
      atencao: "Nunca confrontar, ameaçar ou fazer avaliação jurídica."
    },
    {
      pergunta: "Quero desconto maior",
      principal: "Entendo. No momento estou te apresentando as condições disponíveis para o seu caso.",
      alternativa: "Se houver justificativa, posso verificar se cabe encaminhamento de proposta de exceção.",
      objetivo: "Valorizar a proposta apresentada.",
      atencao: "Não criar expectativa de aprovação."
    },
    {
      pergunta: "Quero boleto",
      principal: "Posso verificar as opções disponíveis para formalização da negociação por boleto conforme a política vigente.",
      alternativa: "Vamos conferir se o boleto está disponível para este tipo de negociação.",
      objetivo: "Facilitar o avanço dentro da regra.",
      atencao: "Validar a política antes da formalização."
    },
    {
      pergunta: "Não confio em negociação por WhatsApp",
      principal: "Entendo. O atendimento deve ocorrer pelos canais oficiais da ReATIVA e podemos confirmar os dados e procedimentos por esses meios.",
      alternativa: "Se preferir, podemos utilizar outro canal oficial disponível para formalizar as informações.",
      objetivo: "Transmitir segurança e credibilidade.",
      atencao: "Sempre reforçar canais oficiais."
    },
    {
      pergunta: "Preciso do diploma/documento",
      principal: "Entendo. Podemos verificar sua situação financeira e orientar a regularização, mas a liberação de documentos depende da análise da área responsável.",
      alternativa: "Posso te orientar sobre a parte financeira e indicar o canal adequado para a questão documental.",
      objetivo: "Separar negociação financeira de procedimento acadêmico.",
      atencao: "Não prometer liberação automática de documentos."
    },
    {
      pergunta: "Quero liberar matrícula / Preciso voltar a estudar",
      principal: "Entendo. Podemos verificar as condições disponíveis para regularização da pendência financeira.",
      alternativa: "Depois da regularização, qualquer questão de matrícula deve ser confirmada com a área responsável.",
      objetivo: "Apoiar a regularização sem prometer resultado acadêmico.",
      atencao: "Não garantir matrícula ou rematrícula."
    },
    {
      pergunta: "Não consigo pagar esse valor mensal",
      principal: "Entendo. Podemos verificar uma composição prevista na política que fique mais adequada à sua realidade.",
      alternativa: "Vamos conferir as opções disponíveis antes de definirmos a melhor condição.",
      objetivo: "Adequar a negociação à capacidade informada.",
      atencao: "Respeitar os limites da política de negociação."
    },
    {
      pergunta: "Estou descontente com a universidade",
      principal: "Entendo sua insatisfação e respeito seu posicionamento. Meu objetivo aqui é ajudar na parte financeira sem desconsiderar o seu relato.",
      alternativa: "Podemos registrar sua observação e, separadamente, verificar as possibilidades de regularização da pendência.",
      firme: "A questão acadêmica pode seguir pelo canal responsável enquanto tratamos, se você desejar, das opções financeiras disponíveis.",
      objetivo: "Separar a insatisfação institucional da negociação financeira.",
      atencao: "Nunca discutir, minimizar a reclamação ou defender excessivamente a instituição."
    },
    {
      pergunta: "Perda do desconto de antecipação",
      principal: "Entendo a sua dúvida. Vamos conferir o contrato ou termo aplicável e a regra vigente para explicar corretamente a composição do valor após o vencimento.",
      alternativa: "Posso verificar o registro do seu caso e detalhar os encargos aplicados.",
      objetivo: "Esclarecer a cobrança com base na regra efetivamente aplicável.",
      atencao: "Não citar cláusula antiga nem afirmar que um valor é devido sem validar o contrato e a regra vigente."
    },
    {
      pergunta: "MEC / Cursos de Medicina",
      principal: "Entendo sua dúvida. Antes de responder sobre funcionamento, calendário ou orientação do MEC, precisamos conferir a comunicação institucional vigente para a unidade e o curso.",
      alternativa: "Posso verificar a orientação oficial mais recente e te direcionar corretamente.",
      objetivo: "Evitar repassar informação institucional desatualizada.",
      atencao: "Não afirmar situação de curso, calendário ou MEC sem orientação oficial atual."
    },
    {
      pergunta: "Não fui eu quem fez o acordo",
      principal: "Entendo a dúvida. Vou confirmar os dados cadastrais e o histórico antes de seguirmos.",
      alternativa: "Vamos validar o registro do acordo antes de qualquer conclusão.",
      objetivo: "Garantir que a tratativa esteja vinculada à pessoa e ao acordo corretos.",
      atencao: "Não atribuir responsabilidade antes da validação."
    },
    {
      pergunta: "Já fiz acordo antes e não deu certo",
      principal: "Entendo. Vamos revisar o cenário atual e verificar o que é possível dentro das regras vigentes.",
      alternativa: "Posso conferir o histórico do acordo anterior e as condições disponíveis agora.",
      objetivo: "Retomar a negociação com base no histórico real.",
      atencao: "Não prometer condição diferente sem previsão na política."
    },
    {
      pergunta: "Por que estou pagando 8% a mais?",
      principal: "Esse percentual corresponde aos honorários de cobrança previstos no Contrato de Prestação de Serviços para débitos acima de 30 dias.",
      objetivo: "Informar de forma objetiva a origem dos honorários, sem gerar uma tratativa adicional desnecessária.",
      atencao: "Não chamar de taxa bancária, taxa da operadora ou taxa do estabelecimento. A previsão dos honorários consta no contrato de prestação de serviços."
    }
  ];
