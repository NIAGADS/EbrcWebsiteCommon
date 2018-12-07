import { RecordAttribute } from 'wdk-client/Components';
import { renderWithCustomElements } from '../util/customElements';
import { findExportWith } from './util';

// Wrappers
// --------

export function RecordHeading(DefaultComponent) {
  const DynamicRecordHeading = makeDynamicWrapper('RecordHeading')(DefaultComponent);
  return function EbrcRecordHeading(props) {
    return (
      <div>
        <DynamicRecordHeading {...props}/>
        {renderWithCustomElements(props.record.attributes.record_overview)}
      </div>
    )
  }
}

export function RecordMainSection(DefaultComponent) {
  const DynamicRecordMainSection = makeDynamicWrapper('RecordMainSection')(DefaultComponent);
  return function EbrcRecordMainSection(props) {
    return (
      <div>
        <DynamicRecordMainSection {...props}/>
        {!props.depth && ('attribution' in props.record.attributes) && (
          <div className='RecordAttribution'>
            <hr/>
            <h3>Record Attribution</h3>
            <RecordAttribute
              attribute={props.recordClass.attributesMap.attribution}
              record={props.record}
              recordClass={props.recordClass}
            />
          </div>
        )}
      </div>
    );
  };
}

export const RecordTable = makeDynamicWrapper('RecordTable');


// Helpers
// -------

const findRecordPageComponent = findExportWith(require.context('../components/records', true));

/**
 * Uses partially applied `findRecordPageComponent` function to dynamically
 * "import" a component from a record class module.
 *
 * @example
 * ```
 * const RecordTable = makeDynamicWrapper(findRecordPageComponent('RecordTable'));
 * ```
 */
function makeDynamicWrapper(componentName) {
  return function dynamicWrapper(DefaultComponent) {
    return function DynamicWrapper(props) {
      const ResolvedComponent = findRecordPageComponent(componentName)(`./${props.recordClass.name}`) || DefaultComponent;
      return (
        <ResolvedComponent {...props} DefaultComponent={DefaultComponent}/>
      );
    }
  }
}
