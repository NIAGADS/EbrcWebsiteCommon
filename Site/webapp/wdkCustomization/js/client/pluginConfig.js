import {
  HistogramAnalysisPlugin, 
  WordCloudAnalysisPlugin, 
  StepAnalysisViewPlugin,
  ResultTableSummaryViewPlugin, 
} from 'wdk-client/Plugins';

import { EbrcDefaultQuestionForm } from './components/questions/EbrcDefaultQuestionForm';
import QuestionWizardPlugin from './plugins/QuestionWizardPlugin';

export default [
  {
    type: 'attributeAnalysis',
    name: 'wordCloud',
    component: WordCloudAnalysisPlugin
  },
  {
    type: 'attributeAnalysis',
    name: 'histogram',
    component: HistogramAnalysisPlugin
  },
  {
    type: 'stepAnalysis',
    name: 'stepAnalysis',
    component: StepAnalysisViewPlugin
  },
  {
    type: 'summaryView',
    name: '_default',
    component: ResultTableSummaryViewPlugin
  },
  {
    type: 'questionController',
    test: ({ question }) => question && question.properties.websiteProperties && question.properties.websiteProperties.includes('useWizard'),
    component: QuestionWizardPlugin
  },
  {
    type: 'questionForm',
    component: EbrcDefaultQuestionForm
  }
];
