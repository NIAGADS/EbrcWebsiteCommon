/*global wdk*/

import $ from 'jquery';
import {
  ary,
  debounce,
  flow,
  get,
  groupBy,
  identity,
  isEqual,
  keyBy,
  mapValues,
  memoize,
  partition,
  pick,
  reverse,
  sortBy,
  stubTrue as T
} from 'lodash';
import natsort from 'natural-sort';
import PropTypes from 'prop-types';
import React from 'react';

import { Dialog } from 'wdk-client/Components';
import { wrappable } from 'wdk-client/ComponentUtils';
import { ViewController } from 'wdk-client/Controllers';
import { isMulti, isRange } from 'wdk-client/AttributeFilterUtils';
import { Seq } from 'wdk-client/IterableUtils';
import { synchronized } from 'wdk-client/PromiseUtils';
import { preorder } from 'wdk-client/TreeUtils';
import { WdkStore } from 'wdk-client/Stores';

import QuestionWizard from '../components/QuestionWizard';
import {
  createInitialState,
  createInitialParamState,
  getDefaultParamValues,
  setFilterPopupVisiblity,
  setFilterPopupPinned,
  resetParamValues
} from '../util/QuestionWizardState';

const natSortComparator = natsort();

//  type State = {
//    question: Question;
//    activeGroup: Group;
//    groupUIState: Record<string, {
//      valid?: boolean;
//      loading?: boolean;
//      accumulatedTotal?: boolean;
//    }>;
//    paramUIState: Record<string, any>;
//    paramValues: Record<string, string>;
//  }

// FIXME Don't update param dependencies if value is empty

/**
 * Controller for question wizard
 *
 * FIXME Move state management into a Store. As-is, there are potential race
 * conditions due to `setState()` being async.
 */
class QuestionWizardController extends ViewController {

  constructor(props) {
    super(props);
    this.state = { };
    this.parameterMap = null;
    this.eventHandlers = mapValues(this.getEventHandlers(), handler => handler.bind(this));

    this._getAnswerCount = memoize(this._getAnswerCount, (...args) => JSON.stringify(args));
    this._getFilterCounts = memoize(this._getFilterCounts, (...args) => JSON.stringify(args));
    this._updateGroupCounts = synchronized(this._updateGroupCounts);
    this._commitParamValueChange = debounce(synchronized(this._commitParamValueChange), 1000);

    this.childRef = React.createRef();
  }

  getStoreClass() {
    return WdkStore;
  }

  getStateFromStore() {
    return {};
  }

  getEventHandlers() {
    return pick(this, [
      'setActiveGroup',
      'setActiveOntologyTerm',
      'setOntologyTermSort',
      'setOntologyTermSearch',
      'setParamState',
      'setParamValue',
      'updateInvalidGroupCounts',
      'updateOntologyTermSummary',
      'setFilterPopupVisiblity',
      'setFilterPopupPinned',
      'resetParamValues'
    ]);
  }

  loadQuestion(props) {
    const { questionName, wdkService, isRevise, paramValues } = props;

    const question$ = isRevise ?
      wdkService.getQuestionGivenParameters(questionName, paramValues) :
      wdkService.getQuestionAndParameters(questionName);

    const recordClass$ = question$.then(question => {
      return wdkService.findRecordClass(rc => rc.name === question.recordClassName);
    });

    Promise.all([ question$, recordClass$ ]).then(
      ([ question, recordClass ]) => {
        this.setState(createInitialState(question, recordClass, paramValues), () => {
          document.title = `Search for ${recordClass.displayName} by ${question.displayName}`;

          // store <string, Parameter>Map for quick lookup
          this.parameterMap = new Map(question.parameters.map(p => [ p.name, p ]))

          const defaultParamValues = getDefaultParamValues(this.state);
          const lastConfiguredGroup = Seq.from(question.groups)
            .filter(group => group.parameters.some(paramName => paramValues[paramName] !== defaultParamValues[paramName]))
            .last();
          const configuredGroups = lastConfiguredGroup == null ? []
            : Seq.from(question.groups)
                .takeWhile(group => group !== lastConfiguredGroup)
                .concat(Seq.of(lastConfiguredGroup));

          this._updateGroupCounts(configuredGroups);
          this._getAnswerCount({
            questionName: question.name,
            parameters: defaultParamValues
          }).then(initialCount => {
            this.setState({ initialCount });
          });

          this.setActiveGroup(question.groups[0]);
        });
      },
      error => {
        this.setState({ error });
      }
    );
  }

  // Top level action creator methods
  // --------------------------------


  /**
   * Update selected group and its count.
   */
  setActiveGroup(activeGroup) {
    this.setState({ activeGroup });

    if (activeGroup == null) return;

    // FIXME Updating group counts and filter param counts needs to wait for
    // any dependent param updates to finish first.

    // Update counts for active group and upstream groups
    const groupsToUpdate = Seq.from(this.state.question.groups)
      .takeWhile(group => group !== activeGroup)
      .concat(Seq.of(activeGroup));

    this._updateGroupCounts(groupsToUpdate);

    // TODO Perform sideeffects elsewhere
    // BEGIN_SIDE_EFFECTS
    this._initializeActiveGroupParams(activeGroup);
    // END_SIDE_EFFECTS
  }

  setParamState(param, state) {
    this.setState(set(['paramUIState', param.name], state));
  }

  /**
   * Set filter popup visiblity
   */
  setFilterPopupVisiblity(show) {
    this.setState(state => setFilterPopupVisiblity(state, show));
  }

  /**
   * Set filter popup stickyness
   */
  setFilterPopupPinned(pinned) {
    this.setState(state => setFilterPopupPinned(state, pinned));
  }

  /**
   * Set all params to default values, then update group counts and ontology term summaries
   */
  resetParamValues() {
    // reset values
    this.setState(resetParamValues, () => {
      this._updateGroupCounts(
        Seq.from(this.state.question.groups)
          .filter(group => this.state.groupUIState[group.name].accumulatedTotal != null));
    })

    // clear ontology term summaries
    const paramUIState = mapValues(this.state.paramUIState, state => ({
      ...state,
      fieldStates: mapValues(state.fieldStates, fieldState => ({
        ...fieldState,
        summary: null
      }))
    }));

    this.setState({ paramUIState }, () => {
      Seq.from(this.state.activeGroup.parameters)
        .map(paramName => this.parameterMap.get(paramName))
        .filter(param => param.type === 'FilterParamNew')
        .forEach(param => {
          this.setActiveOntologyTerm(param, [], this.state.paramUIState[param.name].activeOntologyTerm);
        })
    })
  }

  /**
   * Force an update of ontology term counts. If `ontologyTerm` isMulti, then
   * update all of it's children's counts.
   */
  updateOntologyTermSummary(paramName, ontologyTerm) {
    const { filters } = JSON.parse(this.state.paramValues[paramName]);
    this._updateOntologyTermSummary(paramName, ontologyTerm, filters);
  }

  /**
   * Force stale counts to be updated.
   */
  updateInvalidGroupCounts() {
    this._updateGroupCounts(
      Seq.from(this.state.question.groups)
        .filter(group => this.state.groupUIState[group.name].valid === false));
  }

  /**
   * Update paramUI state based on ontology term.
   */
  setActiveOntologyTerm(param, filters, ontologyTerm) {
    const {
      summary,
      loading = false,
      invalid = false,
      multiLeafInvalid = false
    } = get(this.state, ['paramUIState', param.name, 'fieldStates', ontologyTerm], {});
    if ((summary == null || invalid || multiLeafInvalid) && !loading) {
      this._updateOntologyTermSummary(param.name, ontologyTerm, filters);
    }
    this.setState(set(['paramUIState', param.name, 'activeOntologyTerm'], ontologyTerm));
  }

  setOntologyTermSort(param, term, sort) {
    let uiState = this.state.paramUIState[param.name];
    let field = uiState.ontology.find(field => field.term === term);
    if (field == null || isRange(field)) return;

    this.setState(update(
      ['paramUIState', param.name],
      uiState => {
        let { fieldStates, defaultMemberFieldState, defaultMultiFieldState } = uiState;
        let { filters = [] } = JSON.parse(this.state.paramValues[param.name]);
        let filter = filters.find(f => f.field === term);

        return {
          ...uiState,
          fieldStates: {
            ...fieldStates,
            [term]: {
              ...(fieldStates[term] || isMulti(field) ? defaultMultiFieldState : defaultMemberFieldState),
              sort,
              summary: isMulti(field)
                ? sortMultiFieldSummary(fieldStates[term].summary, uiState.ontology, sort)
                : {
                  ...fieldStates[term].summary,
                  valueCounts: sortDistribution(fieldStates[term].summary.valueCounts, sort, filter)
                }
            }
          }
        };
      }
    ));
  }

  setOntologyTermSearch(param, term, searchTerm) {
    let uiState = this.state.paramUIState[param.name];
    let { fieldStates, defaultMemberFieldState } = uiState;
    let newState = Object.assign({}, uiState, {
      fieldStates: Object.assign({}, fieldStates, {
        [term]: Object.assign({}, fieldStates[term] || defaultMemberFieldState, {
          searchTerm
        })
      })
    });
    this.setParamState(param, newState);
  }

  /**
   * Update parameter value, update dependent parameter vocabularies and
   * ontologies, and update counts.
   */
  setParamValue(param, paramValue) {
    const prevParamValue = this.state.paramValues[param.name];

    this.setState(set(['paramValues', param.name], paramValue),
      () => this._commitParamValueChange(param, paramValue, prevParamValue));
    this.setState(set(['groupUIState', param.group, 'loading'], true));

    if (param.type === 'FilterParamNew') {
      // for each changed member updated member field, resort
      let paramState = this.state.paramUIState[param.name];
      let { filters = [] } = JSON.parse(paramValue);
      let { filters: prevFilters = [] } = JSON.parse(this.state.paramValues[param.name]);
      let filtersByTerm = keyBy(filters, 'field');
      let prevFiltersByTerm = keyBy(prevFilters, 'field');
      let fieldMap = new Map(paramState.ontology.map(entry => [ entry.term, entry ]));
      let fieldStates = mapValues(paramState.fieldStates, (fieldState, term) =>
        isRange(fieldMap.get(term)) || filtersByTerm[term] === prevFiltersByTerm[term]
        ? fieldState
        : { ...fieldState, ...isMulti(fieldMap.get(term))
          ? {
              ...fieldState,
              summary: sortMultiFieldSummary(
                fieldState.summary,
                paramState.ontology,
                (paramState.fieldStates[term] || paramState.defaultMultiFieldState).sort
              )
            }
          : {
            ...fieldState,
            summary: {
              ...fieldState.summary,
              valueCounts: sortDistribution(
                fieldState.summary.valueCounts,
                (paramState.fieldStates[term] || paramState.defaultMemberFieldState).sort,
                filtersByTerm[term]
              )
            }
          }
        }
      );
      this.setParamState(param, Object.assign({}, paramState, { fieldStates }));
    }
  }

  _initializeActiveGroupParams(activeGroup) {
    activeGroup.parameters.forEach(paramName => {
      const param = this.state.question.parameters.find(param => param.name === paramName);
      if (param == null) throw new Error("Could not find param `" + paramName + "`.");
      if (param.type === 'FilterParamNew') {
        const {
          activeOntologyTerm,
          fieldStates,
          ontology
        } = this._getParamUIState(this.state, paramName);
        const { filters } = JSON.parse(this.state.paramValues[param.name]);
        const activeOntologyItem = ontology.find(item => item.term === activeOntologyTerm);
        this._updateFilterParamCounts(param.name, filters);
        if (activeOntologyItem && (
          fieldStates[activeOntologyTerm] == null ||
          fieldStates[activeOntologyTerm].summary == null ||
          fieldStates[activeOntologyTerm].invalid
        )) {
          this._updateOntologyTermSummary(param.name, activeOntologyTerm, filters);
        }
      }
    })
  }

  _commitParamValueChange(param, paramValue, prevParamValue) {
    const groups = Seq.from(this.state.question.groups);
    const currentGroup = groups.find(group => group.parameters.includes(param.name));
    groups
      .dropWhile(group => group !== currentGroup)
      .drop(1)
      .takeWhile(group => this._groupHasCount(group))
      .forEach(group => {
        this.setState(set(['groupUIState', group.name, 'valid'], false));
      })

    return Promise.all([
      this._handleParamValueChange(param, paramValue, prevParamValue),
      this._updateDependedParams(param, paramValue, this.state.paramValues).then(nextState => {
        this.setState(nextState, () => {
          this._updateGroupCounts(groups
            .takeWhile(group => group !== this.state.activeGroup)
            .concat(Seq.of(this.state.activeGroup)));
          // If an upstream group has changed, update active group's params
          this._initializeActiveGroupParams(this.state.activeGroup);
        });
      })
    ]);
  }

  _handleParamValueChange(param, paramValue, prevParamValue) {
    if (param.type === 'FilterParamNew') {
      const { filters = [] } = JSON.parse(paramValue);
      const { filters: oldFilters = [] } = JSON.parse(prevParamValue);
      const { ontology } = this.state.paramUIState[param.name];

      // Get an array of fields whose associated filters have been modified.
      const modifiedFields = Object.entries(groupBy(filters.concat(oldFilters), 'field'))
        .filter(([, filters]) => (
          // filter was added or removed
          filters.length === 1 ||
          // filter was modified
          !isEqual(filters[0], filters[1])
        ))
        .map(([ field ]) => ontology.find(entry => entry.term === field));

      if (modifiedFields.length > 0) {
        const firstModifiedField = modifiedFields[0];
        this.setState(update(
          ['paramUIState', param.name, 'fieldStates'],
          fieldStates => mapValues(fieldStates, (fieldState, term) => ({
            ...fieldState,
            invalid: modifiedFields.length > 1 || firstModifiedField.term !== term,
            multiLeafInvalid: isMulti(firstModifiedField)
          }))
        ));
      }

      return this._updateFilterParamCounts(param.name, filters)
    }

    return Promise.resolve();
  }

  /**
   * Returns a new object with updated paramValues and paramUIState
   * @param {*} rootParam
   * @param {*} paramValue
   */
  _updateDependedParams(rootParam, paramValue, paramValues) {
    return this.props.wdkService.getQuestionParamValues(
      this.state.question.urlSegment,
      rootParam.name,
      paramValue,
      paramValues
    ).then(
      // for each parameter returned, reset param value and state
      parameters =>
        Seq.from(parameters)
          .uniqBy(p => p.name)
          .flatMap(param => [
            set(['paramUIState', param.name], createInitialParamState(param)),
            set(['paramValues', param.name], param.defaultValue)
          ])
          .reduce(ary(flow, 2), identity)
    ).then(updater =>
      // Then, invalidate ontologyTermSummaries for dependent FilterParamNew params
      Seq.from(this._getDeepParameterDependencies(rootParam))
        .filter(parameter => parameter.type === 'FilterParamNew')
        .map(parameter =>
          update(
            ['paramUIState', parameter.name, 'fieldStates'],
            fieldStates => mapValues(fieldStates, fieldState => ({ ...fieldState, invalid: true }))
          )
        )
        .reduce(ary(flow, 2), updater)
    )

  }

  _getDeepParameterDependencies(rootParameter) {
    return Seq.from(rootParameter.dependentParams)
      .map(paramName => this.parameterMap.get(paramName))
      .flatMap(parameter => Seq.of(parameter).concat(this._getDeepParameterDependencies(parameter)));
  }

  /**
   * Fetch answer value for each group of parameters and update state with
   * counts. Default values will be used for parameters in groups to the right
   * of each group, and user supplied values will be used for the rest.
   *
   * @param {Iterable<Group>} groups
   */
  _updateGroupCounts(groups) {

    // set loading state for group counts
    const groupUIState = groups.reduce((state, group) => Object.assign(state, {
      [group.name]: Object.assign({}, state[group.name], {
        loading: true,
        valid: false
      })
    }), Object.assign({}, this.state.groupUIState));

    this.setState({ groupUIState });

    const defaultParamValues = getDefaultParamValues(this.state);

    // transform each group into an answer value promise with accumulated param
    // values of previous groups
    const stateByGroup = Seq.from(groups)
      .map(group => Seq.from(this.state.question.groups)
        .takeWhile(g => g !== group)
        .concat(Seq.of(group)))
      .map(groups => [
        groups.last(),
        {
          questionName: this.state.question.name,
          parameters: groups.reduce((paramValues, group) => {
            return group.parameters.reduce((paramValues, paramName) => {
              return Object.assign(paramValues, {
                [paramName]: this.state.paramValues[paramName]
              });
            }, paramValues);
          }, Object.assign({}, defaultParamValues))
        }
      ])
      .map(([ group, answerSpec ]) => {
        const params = group.parameters.map(paramName => this.parameterMap.get(paramName));
        // TODO Use countPredictsAnswerCount FilterParamNew property
        return (params.length === 1 && params[0].type === 'FilterParamNew'
          ? this._getFilterCounts(
              params[0].name,
              JSON.parse(this.state.paramValues[params[0].name]).filters,
              answerSpec.parameters
            ).then(counts => counts.filtered)

          : this._getAnswerCount(answerSpec)
        ).then(
          totalCount => [ group, { accumulatedTotal: totalCount, valid: true, loading: false} ],
          error => {
            console.error('Error loading group count for %o.', group, error);
            return [ group, { valid: false, loading: false } ];
          }
        ).then(
          ([ group, state ]) => {
            const groupUIState = Object.assign({}, this.state.groupUIState, {
              [group.name]: Object.assign({}, this.state.groupUIState[group.name], state)
            });
            this.setState({ groupUIState });
          }
        );
      });

    return Promise.all(stateByGroup);
  }

  _getAnswerCount(answerSpec) {
    const formatting = {
      formatConfig: {
        pagination: { offset: 0, numRecords: 0 }
      }
    };
    return this.props.wdkService.getAnswer(answerSpec, formatting).then(
      answer => answer.meta.totalCount,
      error => {
        this.setState({ error });
      }
    );
  }

  _getFilterCounts(paramName, filters, paramValues) {
    return this.props.wdkService.getFilterParamSummaryCounts(
      this.state.question.urlSegment,
      paramName,
      filters,
      paramValues
    );
  }

  _updateFilterParamCounts(paramName, filters) {
    return this._getFilterCounts(paramName, filters, this.state.paramValues).then(
      counts => {
        this.setState(update(
          ['paramUIState', paramName],
          uiState => ({
            ...uiState,
            filteredCount: counts.nativeFiltered,
            unfilteredCount: counts.nativeUnfiltered
          })
        ));
      },
      error => {
        this.setState({ error });
      }
    );
  }

  _updateOntologyTermSummary(paramName, ontologyTerm, filters) {
    const { ontology } = this.state.paramUIState[paramName];
    const ontologyItem = ontology.find(item => item.term === ontologyTerm);

    const { defaultMultiFieldState, defaultMemberFieldState, defaultRangeFieldState } = this.state.paramUIState[paramName];

    this.setState(update(
      ['paramUIState', paramName, 'fieldStates'],
      fieldStates => {
        const fieldState = fieldStates[ontologyTerm] ||
          ( isMulti(ontologyItem) ? defaultMultiFieldState
          : isRange(ontologyItem) ? defaultRangeFieldState
          : defaultMemberFieldState );
        return { ...fieldStates, [ontologyTerm]: { ...fieldState, loading: true } };
      }
    ));

    if (ontologyItem && isMulti(ontologyItem)) {
      // find all leaves
      const leafTerms = Seq.of(groupBy(ontology, 'parent'))
        .flatMap(parentMap =>
          Seq.from(preorder(ontologyItem, item => parentMap[item.term] || []))
            .filter(item => parentMap[item.term] == null)
            .map(item => item.term));

      const [ [ multiFilter ], otherFilters ] = partition(filters, filter => filter.field === ontologyTerm);

      const leafSummaryPromises = leafTerms
        .map(leafTerm =>
          this.props.wdkService.getOntologyTermSummary(
            this.state.question.urlSegment,
            paramName,
            // If UNION, don't include any leafTerms; if INTERSECT don't include current childTerm.
            otherFilters.concat(
              multiFilter == null || multiFilter.value.operation === 'union' ? []
              : updateObjectImmutably(multiFilter, [ 'value', 'filters' ], filters => filters.filter(filter => filter.field !== leafTerm))
            ),
            leafTerm,
            this.state.paramValues
          )
          .then(summary => ({ ...summary, term: leafTerm }))
        );

      return Promise.all(leafSummaryPromises).then(
        leafSummaries => {
          const { ontology } = this.state.paramUIState[paramName];
          this.setState(update(
            ['paramUIState', paramName, 'fieldStates', ontologyTerm],
            fieldState => ({
              ...fieldState,
              loading: false,
              invalid: false,
              multiLeafInvalid: false,
              summary: sortMultiFieldSummary(leafSummaries, ontology, fieldState.sort)
            })
          ));
        },
        error => {
          this.setState({ error });
          this.setState(update(
            ['paramUIState', paramName, 'fieldStates', ontologyTerm],
            fieldState => ({
              ...fieldState,
              loading: false
            })
          ));
        }
      );
    }

    return this.props.wdkService.getOntologyTermSummary(
      this.state.question.urlSegment,
      paramName,
      filters.filter(filter => filter.field !== ontologyTerm),
      ontologyTerm,
      this.state.paramValues
    ).then(
      summary => {
        this.setState(update(
          ['paramUIState', paramName, 'fieldStates', ontologyTerm],
          fieldState => {
            if (!isRange(ontologyItem)) {
              summary.valueCounts = sortDistribution(
                summary.valueCounts,
                fieldState.sort,
                filters
              );
            }
            return {
              ...fieldState,
              loading: false,
              invalid: false,
              summary
          };
          }
        ));
      },
      error => {
        this.setState({ error });
        this.setState(update(
          ['paramUIState', paramName, 'fieldStates', ontologyTerm],
          fieldState => ({ ...fieldState, loading: false })
        ))
      }
    );
  }

  _getParamUIState(state, paramName) {
    return state.paramUIState[paramName];
  }

  _groupHasCount(group) {
    return this.state.groupUIState[group.name].accumulatedTotal != null;
  }

  isRenderDataLoaded() {
    return this.state.question != null;
  }

  isRenderDataLoadError() {
    return this.state.question == null && this.state.error != null;
  }

  componentDidMount() {
    this.loadQuestion(this.props);

    // FIXME Figure out to render form element in `QuestionWizard` component
    const $form = $(this.childRef.current).closest('form');
    $form
      .on('submit', () => {
        $form.block()
      })
      .on(wdk.addStepPopup.SUBMIT_EVENT, () => {
        $form.block()
      })
      .on(wdk.addStepPopup.CANCEL_EVENT, () => {
        $form.unblock()
      })
      .prop('autocomplete', 'off')
      .attr('novalidate', '');
  }

  componentDidWillReceiveProps(nextProps) {
    this.loadQuestion(nextProps);
  }

  renderView() {
    return (
      <React.Fragment>
        {this.state.error && (
          <Dialog open modal title="An error occurred" onClose={() => this.setState({ error: undefined })}>
            {Seq.from(this.state.error.stack.split('\n'))
              .flatMap(line => [ line, <br/> ])}
          </Dialog>
        )}
        {this.state.question && (
          <QuestionWizard
            eventHandlers={this.eventHandlers}
            wizardState={this.state}
            customName={this.props.customName}
            isAddingStep={this.props.isAddingStep}
            showHelpText={!this.props.isRevise}
          />
        )}
      </React.Fragment>
    )
  }

  render() {
    return (
      <div ref={this.childRef}>
        {super.render()}
      </div>
    )
  }

}

QuestionWizardController.propTypes = {
  wdkService: PropTypes.object.isRequired,
  questionName: PropTypes.string.isRequired,
  paramValues: PropTypes.object.isRequired,
  isRevise: PropTypes.bool.isRequired,
  isAddingStep: PropTypes.bool.isRequired,
  customName: PropTypes.string
}

QuestionWizardController.defaultProps = {
  get wdkService() {
    return window.ebrc.context.wdkService;
  }
}

export default wrappable(QuestionWizardController);


/**
 * Creates an updater function that returns a new state object
 * with an updated value returns by fn at the specified path, replacing the
 * previous value.
 */
function update(path, fn) {
  return function updateState(state) {
    return updateObjectImmutably(state, path, fn);
  }
}

/**
 * Creates an updater function that returns a new state object
 * with an updated value at the specified path, replacing the previous value.
 */
function set(path, value) {
  return update(path, () => value);
}

/**
 * Creates a new object based on input object with an updated value
 * a the specified path.
 */
function updateObjectImmutably(object, [key, ...restPath], updateFn) {
  const isObject = typeof object === 'object';
  if (!isObject || (isObject && !(key in object)))
    throw new Error("Invalid key path");

  if (typeof updateFn !== 'function') {
    throw new Error("updateFn should be a function.");
  }

  return Object.assign({}, object, {
    [key]: restPath.length === 0
      ? updateFn(object[key])
      : updateObjectImmutably(object[key], restPath, updateFn)
  })
}

/**
 * Compare distribution values using a natural comparison algorithm.
 * @param {string|null} valueA
 * @param {string|null} valueB
 */
function compareDistributionValues(valueA, valueB) {
  return natSortComparator(
    valueA == null ? '' : valueA,
    valueB == null ? '' : valueB
  );
}

function filteredCountIsZero(entry) {
  return entry.filteredCount === 0;
}

/**
 * Sort distribution based on sort spec. `SortSpec` is an object with two
 * properties: `columnKey` (the distribution property to sort by), and
 * `direction` (one of 'asc' or 'desc').
 * @param {Distribution} distribution
 * @param {SortSpec} sort
 */
export function sortDistribution(distribution, sort, filter) {
  let { columnKey, direction, groupBySelected } = sort;
  let selectedSet = new Set(filter ? filter.value : []);
  let selectionPred = groupBySelected
    ? (a) => !selectedSet.has(a.value)
    : T

  // first sort by specified column
  let sortedDist = distribution.slice().sort(function compare(a, b) {
    let order =
      // if a and b are equal, fall back to comparing `value`
      columnKey === 'value' || a[columnKey] === b[columnKey]
        ? compareDistributionValues(a.value, b.value)
        : a[columnKey] > b[columnKey] ? 1 : -1;
    return direction === 'desc' ? -order : order;
  });

  // then perform secondary sort based on filtered count and selection
  return sortBy(sortedDist, [ filteredCountIsZero, selectionPred ])
}

function sortMultiFieldSummary(summaries, ontology, sort) {
  const fields = new Map(ontology.map(o => [o.term, o]));
  const sortedSummaries = sortBy(summaries, entry => sort.columnKey === 'display'
    ? fields.get(entry.term).display
    : entry[sort.columnKey]
  );
  return sort.direction === 'asc' ? sortedSummaries : reverse(sortedSummaries);
}
